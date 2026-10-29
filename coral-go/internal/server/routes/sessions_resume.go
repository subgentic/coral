package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentmodels"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// Resume restarts with --resume to continue a historical session: worked out first (resumeResolve, resumeCommand),
// so a resume that can't be done fails with the old agent still running; then Restart's own steps for the terminal,
// the board subscription and the start command (#4809: the #4767 fix had to be made in both copies); then the store.
// POST /api/sessions/live/{name}/resume
func (h *SessionsHandler) Resume(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	name := chi.URLParam(r, "name")
	var body resumeRequest
	if err := decodeJSON(r, &body); err != nil || body.SessionID == "" {
		errBadRequest(w, "session_id is required")
		return
	}
	end, free := h.beginRestart(name)
	if !free {
		refuseRestartBusy(w)
		return
	}
	defer end()
	ctx := viaHub(r.Context(), r)
	p, fail := h.resumeResolve(ctx, name, &body)
	if fail != nil {
		fail(w)
		return
	}
	slog.Info("resuming agent", "agent_name", name, "session_id", body.SessionID, "agent_type", p.agentType)
	agentImpl := agent.GetAgent(p.agentType)
	agent.TryPrepareResume(agentImpl, body.SessionID, p.workdir)
	cmd, fail := h.resumeCommand(ctx, p, agentImpl, body.SessionID)
	if fail != nil {
		fail(w)
		return
	}
	ctx, cancel := lifecycleCtx(ctx) // as Restart: from here it runs to its end whatever the request does
	defer cancel()
	target, fail := h.restartTerminal(ctx, p)
	if fail != nil {
		fail(w)
		return
	}
	if fail := h.restartLaunch(ctx, p, target, cmd); fail != nil {
		fail(w)
		return
	}
	h.resumeRecord(ctx, p, body.SessionID)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "session_id": p.newSessionID, "session_name": p.newSessionName,
	})
}

// resumeRequest is a Resume request: the conversation to resume, and the live session it replaces.
type resumeRequest struct {
	SessionID        string `json:"session_id"`
	AgentType        string `json:"agent_type"`
	CurrentSessionID string `json:"current_session_id"`
}

// resumeResolve works out the resume as a restart plan: the type (never a terminal, and one that can resume), the
// live session it replaces (refused when unknown, no longer live or archived), its terminal or, when that is gone,
// its working directory (never another agent's pane, #3213), its stored settings and its board subscription.
func (h *SessionsHandler) resumeResolve(ctx context.Context, name string, body *resumeRequest) (*restartPlan, answer) {
	agentType := body.AgentType
	if agentType == "" {
		agentType = at.Claude
	}
	if agentType == at.Terminal { // a plain shell has no conversation to resume (and no agent CLI to type)
		return nil, func(w http.ResponseWriter) { errBadRequest(w, "Resume not supported for terminal") }
	}
	if !agent.IsResumeID(agentType, body.SessionID) {
		return nil, func(w http.ResponseWriter) { errBadRequest(w, "session_id is not a valid resume id") } // #3582: it goes into file paths
	}
	if !agent.GetAgent(agentType).SupportsResume() {
		return nil, func(w http.ResponseWriter) { errBadRequest(w, fmt.Sprintf("Resume not supported for %s", agentType)) }
	}
	targetSID := body.CurrentSessionID
	if targetSID == "" {
		if _, sid := logparse.ParseSessionName(name); sid != "" {
			targetSID = sid
		} else if _, err := uuid.Parse(name); err == nil {
			targetSID = name
		}
	}
	if namesNoSession(name, targetSID) {
		return nil, writeSessionIDRequired
	}
	ls, err := h.ss.GetLiveSession(ctx, targetSID)
	switch {
	case err != nil:
		slog.Warn("failed to validate live session metadata", "session_id", targetSID, "error", err)
		return nil, func(w http.ResponseWriter) {
			writeError(w, http.StatusServiceUnavailable, "agent_metadata_unavailable", "Agent metadata is temporarily unavailable; try again.")
		}
	case ls == nil:
		return nil, func(w http.ResponseWriter) {
			writeError(w, http.StatusNotFound, "session_not_found", "live session not found")
		}
	case ls.Status != "active" || ls.StoppedAt != nil:
		return nil, func(w http.ResponseWriter) {
			writeError(w, http.StatusConflict, "session_not_live", "session is not live")
		}
	case ls.IsArchived == 1:
		return nil, func(w http.ResponseWriter) {
			writeError(w, http.StatusConflict, "session_archived", "session is archived")
		}
	}
	body.CurrentSessionID = targetSID

	p := &restartPlan{req: restartRequest{SessionID: targetSID, AgentType: agentType}, agentType: agentType, stored: ls, resuming: true}
	pane, _ := h.terminal.FindSession(ctx, name, agentType, targetSID)
	switch {
	case pane != nil:
		p.pane, p.workdir = pane, pane.CurrentPath
	case ls.WorkingDir != "":
		p.fresh, p.workdir = ls, ls.WorkingDir
	default:
		return nil, func(w http.ResponseWriter) { writeTerminalError(w, ptymanager.ErrTerminalGone) }
	}
	p.usePTY = h.restartsOnPTY(ls)
	p.newSessionID = h.uuid()
	p.newSessionName = naming.SessionName(agentType, p.newSessionID)
	p.newLogPath = naming.LogFile(h.cfg.LogDir, agentType, p.newSessionID)
	p.prompt, p.board, p.boardServer = ptr.Value(ls.Prompt), ptr.Value(ls.BoardName), ptr.Value(ls.BoardServer)
	p.displayName, p.boardType, p.tools = ptr.Value(ls.DisplayName), ptr.Value(ls.BoardType), store.UnmarshalFlags(ls.Tools)
	if ls.Capabilities != nil && *ls.Capabilities != "" {
		p.caps = &agent.Capabilities{}
		if err := json.Unmarshal([]byte(*ls.Capabilities), p.caps); err != nil {
			return nil, func(w http.ResponseWriter) {
				errInternalServer(w, fmt.Sprintf("corrupt stored capabilities: %v", err))
			}
		}
		p.capsJSON = ls.Capabilities
	}
	if ls.PermissionMode != nil && *ls.PermissionMode != "" {
		if !agent.ValidPermissionMode(*ls.PermissionMode) {
			return nil, func(w http.ResponseWriter) {
				errInternalServer(w, fmt.Sprintf("corrupt stored permission mode: %s", *ls.PermissionMode))
			}
		}
		p.permMode = *ls.PermissionMode
	} else {
		storedFlags := store.UnmarshalFlags(ls.Flags)
		p.permMode = agent.PermissionModeFromFlags(storedFlags)
	}
	if ls.Model != nil {
		p.model = *ls.Model
	}
	p.contextWindow = ls.ContextWindow
	storedFlags := store.UnmarshalFlags(ls.Flags)
	cleanFlags := stripAgentPermissionFlags(storedFlags)
	cleanFlags = agentmodels.StripThinkingFlags(cleanFlags)
	if carried, _ := agent.SplitPermissionFlags(storedFlags); p.caps.IsEmpty() && len(carried) > 0 {
		cleanFlags = append(cleanFlags, carried...) // what the agent was started with, as it was (#6423)
	} else if p.caps.IsEmpty() && p.permMode != "" && p.permMode != "default" {
		cleanFlags = append(cleanFlags, agent.PermissionFlagsForAgent(agentType, p.permMode)...)
	}
	if t := ptr.Value(ls.Thinking); agentmodels.ValidThinking(agentType, t) { // the resumed agent keeps its level (a resume starts with no other stored flag)
		p.thinking = t
	}
	p.flags = append(cleanFlags, agentmodels.ThinkingArgs(agentType, p.thinking)...)
	// The agent's board subscription (job title, receive mode, peek), carried to the new session as restart does
	// (#3216); a resume that can't read it goes on without (it then joins its board after the launch).
	if h.bs != nil {
		storedAgentType := agentType
		if ls.AgentType != "" {
			storedAgentType = ls.AgentType
		}
		p.subscription, _ = h.launchSeat(ctx, ls, naming.SessionName(storedAgentType, targetSID))
	}
	return p, nil
}

// resumeCommand builds the resume's start command, before the terminal is touched: when it can't be built
// (#3601 W12), the resume fails with the old agent still running.
func (h *SessionsHandler) resumeCommand(ctx context.Context, p *restartPlan, agentImpl agent.Agent, resumeID string) (string, answer) {
	userSettings, serr := h.launchSettings(ctx)
	if serr != nil { // never resume the agent on the CLI found on PATH (#4350)
		return "", func(w http.ResponseWriter) {
			writeError(w, http.StatusServiceUnavailable, "", serr.Error())
		}
	}
	permMode := p.permMode
	if permMode == "" {
		permMode = setreg.Enum(userSettings, "default_permission_mode")
	}
	cliPath, cerr := agent.LaunchCLI(userSettings, p.agentType) // a broken cli_path_<agent> refuses the resume (#115)
	if cerr != nil {
		refuse, _ := cliPathRefusal(ctx, cerr)
		return "", refuse
	}
	cmd, err := launchCommand(agentImpl, agent.LaunchParams{
		SessionID:       p.newSessionID,
		SessionName:     p.newSessionName,
		ProtocolPath:    h.protocolPath(),
		ResumeSessionID: resumeID,
		Flags:           p.flags,
		WorkingDir:      p.workdir,
		CLIPath:         cliPath, // Settings > CLI paths (#3205)
		BoardName:       p.board,
		BoardLabel:      h.boardLabel(p.board),
		Role:            naming.SubscriberID(p.displayName, p.agentType),
		Prompt:          p.prompt,
		PromptOverrides: promptOverrides(userSettings),
		BoardType:       p.boardType,
		Capabilities:    p.caps,
		Tools:           p.tools,
		PermissionMode:  permMode,
		CoralDir:        h.cfg.CoralDir(),
		CoralHost:       h.cfg.AgentHost(),
		CoralPort:       h.cfg.Port,
		RunTag:          h.runTagFor(ctx, p.newSessionID, storedSessionID(p.stored), ""),
	})
	if err != nil {
		return "", func(w http.ResponseWriter) { errInternalServer(w, err.Error()) }
	}
	return cmd, nil
}

// resumeRecord replaces the old session with the resumed one in the store: its working directory, the conversation
// it resumes, its prompt and board; its name and tags carried forward, as a restart's (#3216); awake (#3273).
func (h *SessionsHandler) resumeRecord(ctx context.Context, p *restartPlan, resumeID string) {
	var resumePID int
	if tmuxTerm, ok := h.terminal.(*ptymanager.TmuxSessionTerminal); ok {
		if pid, err := tmuxTerm.Client().GetPanePID(ctx, p.newSessionName); err == nil {
			resumePID = pid
		}
	}
	oldID := p.req.SessionID
	h.chatMeta.forget(oldID, p.newSessionID)
	h.ss.ReplaceLiveSession(ctx, oldID, &store.LiveSession{
		SessionID:     p.newSessionID,
		AgentType:     p.agentType,
		AgentName:     p.folderName(),
		WorkingDir:    p.workdir,
		ResumeFromID:  ptr.NonEmpty(resumeID),
		Prompt:        ptr.NonEmpty(p.prompt),
		BoardName:     ptr.NonEmpty(p.board),
		BoardServer:   ptr.NonEmpty(p.boardServer),
		BoardType:     ptr.NonEmpty(p.boardType),
		Thinking:      &p.thinking,
		PID:           resumePID,
		Flags:         store.MarshalFlags(p.flags),
		Capabilities:  p.capsJSON,
		Model:         ptr.NonEmpty(p.model),
		ContextWindow: p.contextWindow,
		Tools:         store.MarshalCapabilities(p.tools),
		PermissionMode: func() *string {
			if p.stored != nil {
				return p.stored.PermissionMode
			}
			return nil
		}(),
	})
	h.noteLaunchedHooks(ctx, p.newSessionID, p.agentType) // #3665
	h.ss.MigrateDisplayName(ctx, oldID, p.newSessionID)
	h.ss.MigrateSessionTags(ctx, oldID, p.newSessionID)
	// The new row inherits the sleeping flag; the resumed agent is running now, as after a restart. Left asleep,
	// team wake and the board notifier skipped it until the server restarted (#3273).
	h.ss.SetSessionSleeping(ctx, p.newSessionID, false)
	if p.stored.IsSleeping == 1 && p.board != "" && h.boardHandler != nil {
		h.boardHandler.SetPaused(p.board, false)
	}
	// Re-subscribed in restartLaunch, before the launch (subscriber_id, the role, is stable, so the cursor
	// persists); a resume with no subscription joins its board now.
	if p.subscription == nil && p.board != "" {
		h.setupBoardAndPrompt(p.newSessionID, p.newSessionName, p.agentType, p.board, p.displayName)
	}
}
