package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

func (h *SessionsHandler) wakeExistingSession(ctx context.Context, ls *store.LiveSession) (err error) {
	launched := false // the agent CLI was started again: it loaded the current hook set
	// A team's agents start in the team's home folder, which the Operator may have changed since this one last ran (#10815): the wake uses it and the row follows once it has started.
	movedTo := ""
	if dir := h.teamHomeFolder(ctx, ls); dir != "" && dir != ls.WorkingDir {
		moved := *ls
		moved.WorkingDir = dir
		ls, movedTo = &moved, dir
	}
	defer func() {
		if err == nil && launched && movedTo != "" {
			_ = h.ss.SetLiveWorkingDir(ctx, ls.SessionID, movedTo)
		}
		if err == nil && launched {
			h.noteLaunchedHooks(ctx, ls.SessionID, ls.AgentType)
			_ = h.ss.StampSessionSettings(ctx, ls.SessionID) // the CLI now runs with the stored model and level: turns the transcript recorded before are older than them (#6225)
		}
	}()
	plan, err := h.prepareWake(ctx, ls)
	if err != nil {
		return err
	}
	err = h.startWake(ctx, ls, plan, &launched)
	if err != nil {
		return err
	}
	h.finishWake(ctx, ls, plan)
	return nil
}

type wakePlan struct {
	agentImpl                                             agent.Agent
	params                                                agent.LaunchParams
	backend, sessionName, logFile, boardName, displayName string
}

func (h *SessionsHandler) prepareWake(ctx context.Context, ls *store.LiveSession) (*wakePlan, error) {
	flags := wakeFlags(ls)
	prompt := ptr.Value(ls.Prompt)
	boardName := ptr.Value(ls.BoardName)

	// Inject distilled knowledge on wake
	if boardName != "" {
		prompt = InjectKnowledgeIntoPrompt(h.cfg.CoralDir(), boardName, ptr.Value(ls.DisplayName), prompt)
	}
	boardServer := ptr.Value(ls.BoardServer)
	backend := "tmux"
	if ls.Backend != nil {
		backend = *ls.Backend
	}
	displayName := ptr.Value(ls.DisplayName)
	boardType := ptr.Value(ls.BoardType)
	_ = boardServer // retained for future use

	sessionName := naming.SessionName(ls.AgentType, ls.SessionID)
	logFile := naming.LogFile(h.cfg.LogDir, ls.AgentType, ls.SessionID)

	// A pty Coral holds every agent's terminal itself, whatever backend the agent last ran on
	// (#3634): an agent from a tmux run wakes the pty way (it used to go down the tmux path and
	// fail). If it still runs in Coral's old tmux server, waking it would start a second copy.
	if _, onPTY := h.backend.(*ptymanager.PTYBackend); onPTY {
		backend = "pty"
		if h.inOldTmux != nil && h.inOldTmux(ctx, sessionName) {
			return nil, ErrStillInOldTmux
		}
	}

	agentImpl := agent.GetAgent(ls.AgentType)
	agent.TryPrepareResume(agentImpl, ls.SessionID, ls.WorkingDir)

	userSettings, serr := h.launchSettings(ctx)
	if serr != nil { // never wake the agent on the CLI found on PATH (#4350)
		return nil, serr
	}
	cliPath, err := agent.LaunchCLI(userSettings, ls.AgentType) // a broken cli_path_<agent> refuses the wake (#115)
	if err != nil {
		return nil, err
	}

	role := displayName
	if role == "" {
		role = ls.AgentType
	}

	var caps *agent.Capabilities
	if ls.Capabilities != nil && *ls.Capabilities != "" {
		caps = &agent.Capabilities{}
		if err := json.Unmarshal([]byte(*ls.Capabilities), caps); err != nil {
			return nil, fmt.Errorf("corrupt stored capabilities: %w", err)
		}
	}
	var permMode string
	if ls.PermissionMode != nil && *ls.PermissionMode != "" {
		if !agent.ValidPermissionMode(*ls.PermissionMode) {
			return nil, fmt.Errorf("corrupt stored permission mode: %s", *ls.PermissionMode)
		}
		permMode = *ls.PermissionMode
	} else {
		permMode = agent.PermissionModeFromFlags(flags)
		if permMode == "" {
			permMode = setreg.Enum(userSettings, "default_permission_mode")
		}
	}
	// The mode's flags are added only when the stored flags carry no permission flag at all, in any spelling (#6423): a Plan agent started with its own sandbox flags
	// woke with Auto's after them, and Codex takes the last.
	if carried, _ := agent.SplitPermissionFlags(flags); caps.IsEmpty() && permMode != "" && permMode != "default" && len(carried) == 0 {
		flags = append(flags, agent.PermissionFlagsForAgent(ls.AgentType, permMode)...)
	}

	launchParams := agent.LaunchParams{
		SessionID:       ls.SessionID,
		SessionName:     sessionName,
		ProtocolPath:    h.protocolPath(),
		ResumeSessionID: ls.SessionID,
		Flags:           flags,
		WorkingDir:      ls.WorkingDir,
		BoardName:       boardName,
		BoardLabel:      h.boardLabel(boardName),
		Role:            role,
		Prompt:          prompt,
		PromptOverrides: promptOverrides(userSettings),
		BoardType:       boardType,
		Capabilities:    caps,
		Tools:           store.UnmarshalFlags(ls.Tools),
		CLIPath:         cliPath,
		PermissionMode:  permMode,
		CoralDir:        h.cfg.CoralDir(),
		CoralHost:       h.cfg.AgentHost(),
		CoralPort:       h.cfg.Port,
		RunTag:          h.runTagFor(ctx, ls.SessionID, "", ""),
	}

	// A Codex agent that never completed a turn has no saved session: "codex resume" would end at "No saved session found" and a bare shell. It starts a new one
	// (a wake is asked to bring the agent back, not to resume a particular conversation) (#5222).
	if ls.AgentType == at.Codex && !codexSessionSaved(ls.SessionID) {
		log.Printf("[wake] session=%s: Codex could not find its saved conversation (no link, and no recent rollout carries its marker); starting a new one", sessionName)
		launchParams.ResumeSessionID = ""
	}
	return &wakePlan{agentImpl: agentImpl, params: launchParams, backend: backend, sessionName: sessionName, logFile: logFile, boardName: boardName, displayName: displayName}, nil
}

func (h *SessionsHandler) startWake(ctx context.Context, ls *store.LiveSession, plan *wakePlan, launched *bool) error {
	sessionName, backend := plan.sessionName, plan.backend
	agentImpl, launchParams := plan.agentImpl, plan.params
	boardName, logFile := plan.boardName, plan.logFile
	// If the session is still running (e.g. it was marked sleeping by a false
	// crash detection rather than an actual crash), do NOT relaunch on top of
	// it: tmux new-session fails with "duplicate session" and, worse, the
	// resume command could be typed into the still-running agent's input.
	// Just clear the sleeping flag and re-subscribe below.
	alreadyRunning := false
	if backend == "pty" && h.backend != nil {
		alreadyRunning = h.backend.IsRunning(sessionName)
	} else if h.terminal != nil {
		alreadyRunning = h.terminal.HasSession(ctx, sessionName)
	}
	if alreadyRunning {
		log.Printf("[wake] session=%s is still running — skipping relaunch, clearing sleeping flag only", sessionName)
	}
	// The terminal is there but the agent CLI exited from it, leaving a plain shell (#3219):
	// resume the agent in that shell, as launch does, instead of only clearing the flag.
	if alreadyRunning && ls.AgentType != at.Terminal && h.terminal != nil {
		if exited, fg := ptymanager.AgentExited(ctx, h.terminal, sessionName, ls.AgentType, ls.SessionID); exited {
			cmd, err := launchCommand(agentImpl, launchParams)
			if err != nil {
				return err
			}
			*launched = true
			target := sessionName + ".0"
			if backend == "pty" {
				target = sessionName
			}
			log.Printf("[wake] session=%s: the agent CLI had exited (%s in the foreground); resuming it in the same terminal", sessionName, fg)
			if err := h.startAgentCLI(ctx, boardName, ls.AgentType, target, cmd); err != nil {
				return err
			}
		}
	}

	if !alreadyRunning && ls.AgentType != at.Terminal {
		cmd, err := launchCommand(agentImpl, launchParams)
		if err != nil {
			return err
		}
		*launched = true
		log.Printf("[wake] session=%s agent=%s backend=%s cmd=%s", sessionName, ls.AgentType, backend, cmd)

		if backend == "pty" && h.backend != nil {
			// PTY backend: spawn shell, then send command
			if err := h.backend.Spawn(sessionName, ls.AgentType, ls.WorkingDir, ls.SessionID, "", 200, 50); err != nil {
				return spawnError(err)
			}
			if cmd != "" {
				if pb, ok := h.backend.(*ptymanager.PTYBackend); ok {
					if !pb.WaitReady(sessionName, 5*time.Second) {
						log.Printf("[launch] pty shell not ready after 5s, sending anyway: %s", sessionName)
					}
				} else {
					time.Sleep(500 * time.Millisecond)
				}
				if err := h.startAgentCLI(ctx, boardName, ls.AgentType, sessionName, cmd); err != nil {
					return fmt.Errorf("pty wake command failed: %w", err)
				}
			}
		} else {
			// tmux backend: create session with the EXISTING session name
			ptymanager.ResetAgentLog(logFile) // 0600, never through a link (#3601, W17)
			if err := h.terminal.CreateSession(ctx, sessionName, ls.WorkingDir); err != nil {
				return fmt.Errorf("create session: %w", err)
			}
			h.terminal.StartLogging(ctx, sessionName, logFile)

			folderName := filepath.Base(ls.WorkingDir)
			h.terminal.SetPaneTitle(ctx, sessionName+".0", fmt.Sprintf("%s — %s", folderName, ls.AgentType))

			if err := h.startAgentCLI(ctx, boardName, ls.AgentType, sessionName+".0", cmd); err != nil {
				return err
			}

			// Capture shell PID
			if tmuxTerm, ok := h.terminal.(*ptymanager.TmuxSessionTerminal); ok {
				if pid, err := tmuxTerm.Client().GetPanePID(ctx, sessionName); err == nil {
					h.ss.UpdateSessionPID(ctx, ls.SessionID, pid)
					log.Printf("[wake] captured PID %d for session %s", pid, sessionName)
				}
			}
		}
	}
	return nil
}

func (h *SessionsHandler) finishWake(ctx context.Context, ls *store.LiveSession, plan *wakePlan) {
	sessionName, boardName, displayName := plan.sessionName, plan.boardName, plan.displayName
	// Clear sleeping flag on existing row (no new DB row created)
	h.ss.SetSessionSleeping(ctx, ls.SessionID, false)

	// Re-subscribe to board with existing session name
	if boardName != "" {
		h.setupBoardAndPrompt(ls.SessionID, sessionName, ls.AgentType, boardName, displayName)
	}
}
