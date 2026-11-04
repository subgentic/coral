package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// wakeLocks makes the wakes of one session happen one at a time (#12291): each is a launch line with a token of its own, and a second token revokes the first.
var wakeLocks sync.Map // session id -> *sync.Mutex

func (h *SessionsHandler) wakeExistingSession(ctx context.Context, ls *store.LiveSession) error {
	return h.wakeSession(ctx, ls, false)
}

// wakeSession is wakeExistingSession; noStartPrompt starts the resumed CLI without its first message (an auto-asleep agent woken by a delivery: what woke it already says what to do, #12358). Every other wake
// sends the starting prompt as it always did.
func (h *SessionsHandler) wakeSession(ctx context.Context, ls *store.LiveSession, noStartPrompt bool) (err error) {
	// One wake of a session at a time, and the one that waited finds it awake and does nothing (#12291, the Beta Tester pressed Wake several times after Sleep Team): a second wake of a row it read
	// while it was still asleep built a second launch line, whose new token revoked the first agent's (every coral-board call answered 401), and typed it into the terminal the first had made.
	if ls.IsSleeping == 1 {
		mu, _ := wakeLocks.LoadOrStore(ls.SessionID, &sync.Mutex{})
		mu.(*sync.Mutex).Lock()
		defer mu.(*sync.Mutex).Unlock()
		if cur, gerr := h.ss.GetLiveSession(ctx, ls.SessionID); gerr == nil && cur != nil && cur.IsSleeping == 0 {
			slog.Info("[wake] the agent was woken while this wake waited: nothing to do", "session_id", ls.SessionID)
			return nil
		}
	}
	launched := false                    // the agent CLI was started again: it loaded the current hook set
	var resumeLogOffset int64            // the agent log's size BEFORE the launch is typed: the backstop reads only what is written after it, a line printed the instant the CLI starts included (#12714)
	fresh, resumedClaude := false, false // the conversation was gone and a new one started (the board is told once); a Claude resume the backstop watches (#12714)
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
			h.noteStartSucceeded(ctx, ls.SessionID)          // the launch line was typed now: the safety net's window starts here, and no start failure stands (#353)
			_ = h.ss.StampSessionSettings(ctx, ls.SessionID) // the CLI now runs with the stored model and level: turns the transcript recorded before are older than them (#6225)
			h.watchWakeToken(ls)                             // a few seconds on, did the agent get its token, and is it still the live one (#12291)
			if fresh {
				h.noteFreshStart(ctx, ls) // said once: the next wake finds the new conversation's transcript
			} else if resumedClaude {
				h.watchResumeGone(ls, resumeLogOffset) // the backstop for a transcript that went between the look and Claude's
			}
		}
	}()
	plan, err := h.prepareWake(ctx, ls, noStartPrompt)
	if err != nil {
		return err
	}
	fresh, resumedClaude = plan.freshStart, ls.AgentType == at.Claude && plan.params.ResumeSessionID != ""
	if resumedClaude {
		resumeLogOffset = logSize(plan.logFile)
	}
	err = h.startWake(ctx, ls, plan, &launched)
	if err != nil {
		return err
	}
	h.finishWake(ctx, ls, plan)
	// An agent of this board is awake again, so the pause that sleep put on it ends, whichever path woke it (a person's Wake, auto-wake, an agent that ended and was started again, hooks): a board that
	// stayed paused after a restart sent no nudge for hours (#11182). A pause a person set stays (LiftSleepPause).
	if bn := ptr.Value(ls.BoardName); bn != "" && h.boardHandler != nil {
		if h.boardHandler.LiftSleepPause(bn) {
			slog.Info("[board] resumed a board that sleep had paused: an agent of it is awake", "board", bn, "session_id", ls.SessionID)
		}
	}
	return nil
}

type wakePlan struct {
	agentImpl                                             agent.Agent
	params                                                agent.LaunchParams
	backend, sessionName, logFile, boardName, displayName string
	freshStart                                            bool // the conversation was gone: started new, and the board is told (#12714)
}

func (h *SessionsHandler) prepareWake(ctx context.Context, ls *store.LiveSession, noStartPrompt bool) (*wakePlan, error) {
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
	cliPath, err := agent.LaunchCLIScreened(userSettings, ls.AgentType, h.commonPlaceScreen(ctx)) // a broken cli_path_<agent> refuses the wake (#115)
	if err != nil {
		h.markStartRefused(ctx, ls, err) // a wake nobody watches shows on the card and the board (#353)
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
			// An agent from before modes were recorded, with no permission flag: the mode its chat was started in where its transcript has one (#12718), else Default, as a restart does (#10297). Never the saved
			// default: it may be Auto, and an agent started with Bypass woke in it and stopped at every prompt.
			if m := h.transcriptStartMode(ctx, ls, flags); m != "" {
				permMode = m
				if err := h.ss.SetLivePermissionModeIfEmpty(ctx, ls.SessionID, m); err != nil {
					slog.Warn("[wake] the start mode read from the transcript was not recorded", "session_id", ls.SessionID, "err", err)
				}
			} else {
				permMode = "default"
				slog.Info("[wake] no permission mode was recorded for this agent: it starts in Default", "session_id", ls.SessionID)
			}
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

	// A Claude agent whose conversation is gone starts a new one under the same session id (#12714): looked for here, before the launch, and the CLI's own "No conversation found" line is only a backstop. "Gone" needs both that
	// Coral finds no transcript AND that Coral once read one for this session (it recorded token usage from it): an agent whose Claude uses a config folder Coral does not see (its own CLAUDE_CONFIG_DIR) has none of Coral's
	// finds, and is resumed, never started fresh on a lookup that could not have found it.
	freshStart := false
	if ls.AgentType == at.Claude && launchParams.ResumeSessionID != "" && (forceFresh(ls.SessionID) || (!claudeConversationFound(ls.SessionID, ls.WorkingDir) && h.ss.SessionHasTokenUsage(ctx, ls.SessionID))) {
		log.Printf("[wake] session=%s: Claude could not find its conversation (no transcript for it); starting a new one with its role", sessionName)
		launchParams.ResumeSessionID = ""
		freshStart = true
	}
	// Pi, Antigravity and OpenCode (#12778): a wake with nothing to resume starts the agent fresh, with its role, the way Claude does above. Each CLI's own look is Coral's: Pi's session folder is the one Coral makes for it, Antigravity's
	// conversation is the one its hook bound to this session, and OpenCode's is the one Coral stored. Without this a wake passed Antigravity Coral's own id (which agy does not know: it warns "conversation not found" and starts a new
	// one), and an auto-wake sent none of the three its first message, the role, because a resume id was set.
	if !freshStart && launchParams.ResumeSessionID != "" {
		switch ls.AgentType {
		case at.Pi:
			if !agent.PiHasSession(h.cfg.CoralDir(), ls.SessionID) {
				launchParams.ResumeSessionID, freshStart = "", true
			}
		case at.Agy, at.Antigravity:
			if conv := transcriptlink.AgyConversation(ls.SessionID); conv != "" && agent.IsResumeID(at.Agy, conv) && regularFile(transcriptlink.AgyTranscript(conv)) {
				launchParams.ResumeSessionID = conv // the conversation agy knows, not Coral's id for it
			} else {
				launchParams.ResumeSessionID, freshStart = "", true
			}
		case at.Opencode:
			if h.opencode != nil && h.opencodeResumeSession(launchParams) == "" {
				launchParams.ResumeSessionID, freshStart = "", true
			}
		}
		if freshStart {
			log.Printf("[wake] session=%s: %s has no conversation to resume; starting a new one with its role", sessionName, ls.AgentType)
		}
	}
	// A Codex agent that never completed a turn has no saved session: "codex resume" would end at "No saved session found" and a bare shell. It starts a new one
	// (a wake is asked to bring the agent back, not to resume a particular conversation) (#5222).
	if ls.AgentType == at.Codex && !codexSessionSaved(ls.SessionID) {
		log.Printf("[wake] session=%s: Codex could not find its saved conversation (no link, and no recent rollout carries its marker); starting a new one", sessionName)
		launchParams.ResumeSessionID = ""
	}
	// Hermes resumes only by its own session id, never Coral's (a Coral id is not one, so the launch ignored it and every wake started a new, empty conversation, #11936): the one Coral recorded from the agent's hooks,
	// "" when there is none (a new session). It is checked for its shape on the way out (transcriptlink.HermesSession) and again at the launch line, where it is one argument.
	if ls.AgentType == at.Hermes {
		launchParams.ResumeSessionID = transcriptlink.HermesSession(h.cfg.CoralDir(), ls.SessionID)
	}
	// Only a launch that resumes a conversation can go without its first message: one that starts a new conversation (Codex with no saved session, Hermes with no session of its own) has none to lean on.
	launchParams.NoStartPrompt = noStartPrompt && launchParams.ResumeSessionID != ""
	return &wakePlan{agentImpl: agentImpl, params: launchParams, backend: backend, sessionName: sessionName, logFile: logFile, boardName: boardName, displayName: displayName, freshStart: freshStart}, nil
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
	_, onTmux := h.backend.(*ptymanager.TmuxBackend)
	if alreadyRunning && (backend != "pty" || onTmux) && h.terminal != nil {
		// A restart/wake can retain the pane after its pipe worker has gone.
		// StartLogging is idempotent for a healthy pipe; preserve its history.
		// A failure here is a warning, never a failed wake (#13458): the agent is running, and a person's reconnect repairs the pipe.
		if err := ptymanager.EnsureAgentLog(logFile); err != nil {
			log.Printf("[wake] session=%s: the log file could not be prepared, waking without restoring its logging: %v", sessionName, err)
		} else if err := h.terminal.StartLogging(ctx, sessionName, logFile); err != nil {
			log.Printf("[wake] session=%s: the log pipe could not be restored, waking anyway: %v", sessionName, err)
		}
	}
	// The terminal is there but the agent CLI exited from it, leaving a plain shell (#3219):
	// resume the agent in that shell, as launch does, instead of only clearing the flag.
	if alreadyRunning && ls.AgentType != at.Terminal && h.terminal != nil {
		exited, fg, refusal := ptymanager.AgentExitedForLaunch(ctx, h.terminal, sessionName, ls.AgentType, ls.SessionID)
		if refusal != "" {
			// A shell of unknown contents (git-bash, WSL) in the agent's terminal: its launch line is not typed into it, the sleeping flag is
			// cleared as for a running terminal, and the person is told why (Security on #216).
			log.Printf("[wake] session=%s: %s", sessionName, refusal)
			h.noteWake(ls.SessionID, refusal)
		}
		if exited {
			cmd, err := h.launchCommand(ctx, agentImpl, launchParams)
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
		cmd, err := h.launchCommand(ctx, agentImpl, launchParams)
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

// wakeNotes holds, per session id, what a wake had to tell the person and the wake's own reply has not said yet (a launch line not typed
// into a shell of unknown contents, Security on #216).
var wakeNotes sync.Map

// noteWake keeps what the wake of session sid has to tell the person, for the reply (takeWakeNote).
func (h *SessionsHandler) noteWake(sid, note string) { wakeNotes.Store(sid, note) }

// takeWakeNote is what the wake of sid had to tell, once; "" when nothing.
func takeWakeNote(sid string) string {
	if v, ok := wakeNotes.LoadAndDelete(sid); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// regularFile says path names a regular file (not a link, not a folder), "" none.
func regularFile(path string) bool {
	fi, err := os.Lstat(path)
	return path != "" && err == nil && fi.Mode().IsRegular()
}
