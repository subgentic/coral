package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentmodels"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/proxy"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// restartRequest is a restart's body: what the dashboard's restart dialog may change.
type restartRequest struct {
	AgentType    string              `json:"agent_type"`
	ExtraFlags   string              `json:"extra_flags"`
	SessionID    string              `json:"session_id"`
	Prompt       string              `json:"prompt"`
	Model        *string             `json:"model"`
	Thinking     *string             `json:"thinking"` // the thinking level to restart with: nil keeps the stored one, "" clears it (#4969)
	Capabilities *agent.Capabilities `json:"capabilities"`
}

// restartPlan is a restart worked out before anything is touched: the agent, where it runs, its new identity and
// the settings it starts with.
type restartPlan struct {
	req          restartRequest
	agentType    string
	stored       *store.LiveSession // the session being restarted (nil: unknown to the store)
	subscription *board.Subscriber  // its board subscription, carried to the new session
	sleeping     *store.LiveSession // set when it is asleep: it has no terminal
	fresh        *store.LiveSession // set when it starts in a new terminal (asleep, or its terminal is gone)
	pane         *ptymanager.PaneInfo
	workdir      string
	usePTY       bool
	resuming     bool // a Resume, which takes the same steps (#4809)

	newSessionID, newSessionName, newLogPath string

	// The settings it starts with: the stored ones, with the request's changes.
	flags                                                     []string
	prompt, board, boardServer, displayName, boardType, model string
	thinking                                                  string // the thinking level it starts with ("" = the CLI's default)
	thinkingFlag                                              bool   // the agent was started with a level, or this restart sets one: its stored --effort is replaced
	contextWindow                                             int
	caps                                                      *agent.Capabilities
	capsJSON, toolsJSON                                       *string
	tools                                                     []string
	permMode                                                  string
	modeNotRecorded                                           bool // the stored agent had no mode: it restarts in Default and the answer says so
}

// Restart restarts the agent session: worked out first (restartResolve, restartSettings, restartCommand), so
// a restart that can't be done fails with the old agent still running; then the terminal, the board
// subscription and the start command, and the store.
// POST /api/sessions/live/{name}/restart
func (h *SessionsHandler) Restart(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	name := chi.URLParam(r, "name")
	var req restartRequest
	decodeJSON(r, &req)
	if namesNoSession(name, req.SessionID) {
		writeSessionIDRequired(w)
		return
	}
	end, free := h.beginRestart(name)
	if !free {
		refuseRestartBusy(w)
		return
	}
	defer end()
	ctx := viaHub(r.Context(), r)
	plan, fail := h.restartResolve(ctx, name, req)
	if fail != nil {
		fail(w)
		return
	}
	// Through the Coral Hub, extra flags or capabilities that skip permission prompts need the owner's local switch (#126 F4).
	if refuseHubSkip(w, r, h.ss, hubAsksToSkip(plan.agentType, strings.Fields(req.ExtraFlags), req.Capabilities, nil, nil)) {
		return
	}
	plan.restartSettings()
	if plan.stored != nil {
		h.modelSwitches.end(plan.stored.SessionID, "The agent was restarted before the change was confirmed.") // #6219
	}
	cmd, fail := h.restartCommand(ctx, plan)
	if fail != nil {
		fail(w)
		return
	}
	ctx, cancel := lifecycleCtx(ctx) // from here the restart touches the terminals: it runs to its end whatever the request does
	defer cancel()
	target, fail := h.restartTerminal(ctx, plan)
	if fail != nil {
		fail(w)
		return
	}
	if fail := h.restartLaunch(ctx, plan, target, cmd); fail != nil {
		fail(w)
		return
	}
	h.restartRecord(ctx, plan)
	out := map[string]any{"ok": true, "session_id": plan.newSessionID, "session_name": plan.newSessionName}
	if plan.modeNotRecorded {
		out["mode_note"] = "Its mode was not recorded: restarted in Default"
	}
	writeJSON(w, http.StatusOK, out)
}

// restartResolve works out the restart: the stored session (refused when it is no longer live or is archived),
// its type, its board subscription, the model it would start with (checked before anything is touched), and
// whether it starts in a new terminal or respawns its pane.
func (h *SessionsHandler) restartResolve(ctx context.Context, name string, req restartRequest) (*restartPlan, answer) {
	p := &restartPlan{req: req, agentType: req.AgentType}
	if req.SessionID != "" {
		if ls, err := h.ss.GetLiveSession(ctx, req.SessionID); err == nil && ls != nil {
			if ls.Status != "active" || ls.StoppedAt != nil {
				return nil, func(w http.ResponseWriter) {
					writeError(w, http.StatusConflict, "session_not_live", "session is not live")
				}
			}
			if ls.IsArchived == 1 {
				return nil, func(w http.ResponseWriter) {
					writeError(w, http.StatusConflict, "session_archived", "session is archived")
				}
			}
			p.stored = ls
			if ls.Capabilities != nil && *ls.Capabilities != "" {
				p.caps = &agent.Capabilities{}
				if err := json.Unmarshal([]byte(*ls.Capabilities), p.caps); err != nil {
					return nil, func(w http.ResponseWriter) {
						errInternalServer(w, fmt.Sprintf("corrupt stored capabilities: %v", err))
					}
				}
			}
			if ls.PermissionMode != nil && *ls.PermissionMode != "" {
				if !agent.ValidPermissionMode(*ls.PermissionMode) {
					return nil, func(w http.ResponseWriter) {
						errInternalServer(w, fmt.Sprintf("corrupt stored permission mode: %s", *ls.PermissionMode))
					}
				}
			}
			// Restart requests from older clients may omit agent_type. Keep the
			// persisted provider instead of silently switching Codex to Claude.
			if p.agentType == "" && ls.AgentType != "" {
				p.agentType = ls.AgentType
			}
		}
	}
	if p.agentType == "" {
		p.agentType = at.Claude
	}

	// Sessions joined through the board API may have no board_name in the
	// session store. Resolve their subscription before renaming the terminal.
	if h.bs != nil && req.SessionID != "" {
		sub, err := h.launchSeat(ctx, p.stored, naming.SessionName(p.oldAgentType(), req.SessionID))
		if err != nil {
			return nil, func(w http.ResponseWriter) { errInternalServer(w, err.Error()) }
		}
		p.subscription = sub
	}

	// Validate the resolved model before touching the terminal or allocating a
	// replacement session. Restart carries the persisted model when the caller
	// omits one, so provider switches must reject stale cross-provider models
	// before any process or database state is mutated. When the caller explicitly
	// provides an empty model (""), they intend to clear the explicit override so
	// the agent falls back to its configured/default model.
	var preflightModel string
	if req.Model != nil {
		preflightModel = strings.TrimSpace(*req.Model)
	} else if p.stored != nil {
		preflightModel = strings.TrimSpace(ptr.Value(p.stored.Model))
	}
	if err := validateAgentModel(p.agentType, preflightModel); err != nil {
		return nil, func(w http.ResponseWriter) { errBadRequest(w, err.Error()) }
	}
	if req.Thinking != nil && !agentmodels.ValidThinking(p.agentType, strings.TrimSpace(*req.Thinking)) {
		msg := errInvalidThinking(p.agentType)
		return nil, func(w http.ResponseWriter) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg, "field": "thinking"})
		}
	}

	// A sleeping agent has no terminal. Restarting one starts a fresh agent in
	// a new terminal in its working directory, with the restart settings
	// (prompt, model, capabilities); waking would resume the old conversation.
	if p.stored != nil && p.stored.IsSleeping == 1 {
		p.sleeping = p.stored
	}
	// An awake agent whose own terminal is gone (it crashed or was closed) restarts the
	// same way: a fresh terminal in its working directory, never another agent's pane
	// (#3213; before, the restart answered terminal_gone until the agent showed asleep).
	p.fresh = p.sleeping
	if p.fresh == nil && p.stored != nil && p.stored.WorkingDir != "" {
		if pane, err := h.terminal.FindSession(ctx, name, p.oldAgentType(), req.SessionID); err == nil && pane == nil {
			p.fresh = p.stored
		}
	}

	p.newSessionID = h.uuid()
	p.newSessionName = naming.SessionName(p.agentType, p.newSessionID)
	p.newLogPath = naming.LogFile(h.cfg.LogDir, p.agentType, p.newSessionID)

	// Find the terminal before anything is touched.
	if p.fresh != nil {
		p.workdir = p.fresh.WorkingDir
		if dir := h.teamHomeFolder(ctx, p.stored); dir != "" { // a team's agent restarts in the team's home folder (#10815)
			p.workdir = dir
		}
		p.usePTY = h.restartsOnPTY(p.fresh)
		return p, nil
	}
	pane, err := h.terminal.FindSession(ctx, name, p.oldAgentType(), req.SessionID) // the terminal it runs in now: named by the provider it runs on, not the one it is going to run on (#8973)
	if err == nil && pane == nil && req.SessionID != "" {
		return nil, func(w http.ResponseWriter) { writeTerminalError(w, ptymanager.ErrTerminalGone) }
	}
	if err != nil || pane == nil {
		return nil, func(w http.ResponseWriter) { errNotFound(w, "Pane not found") }
	}
	p.pane, p.workdir = pane, pane.CurrentPath
	if dir := h.teamHomeFolder(ctx, p.stored); dir != "" { // not the folder its terminal happens to be in: after a crash that is where the terminal was recovered (#10813, #10815)
		p.workdir = dir
	}
	// A live agent restarts on the backend it runs on: a pty one in a new pty terminal (pty has no rename, and a
	// tmux-style "<name>:0.0" target names no pty session, #4767).
	p.usePTY = h.restartsOnPTY(p.stored)
	return p, nil
}

// sameProvider: gemini, antigravity and agy are one provider (the picker says agy for all three), so a restart from one to another is not a switch.
func sameProvider(a, b string) bool {
	canon := func(t string) string {
		if t == at.Gemini || t == at.Antigravity {
			return at.Agy
		}
		return t
	}
	return canon(a) == canon(b)
}

// oldAgentType is the provider the agent runs on now: its terminal and board subscription are named by it. A restart may switch the provider (agentType is the one it starts with, #8973).
func (p *restartPlan) oldAgentType() string {
	if p.stored != nil && p.stored.AgentType != "" {
		return p.stored.AgentType
	}
	return p.agentType
}

// restartsOnPTY reports whether a restart runs the pty way: on a pty Coral every agent does (#3634); otherwise an
// agent the store records as on the pty backend, when there is one.
func (h *SessionsHandler) restartsOnPTY(ls *store.LiveSession) bool {
	if h.backend == nil {
		return false
	}
	if _, onPTY := h.backend.(*ptymanager.PTYBackend); onPTY {
		return true
	}
	return ls != nil && ls.Backend != nil && *ls.Backend == "pty"
}

// restartSettings is what the agent starts with: the stored session's settings (its board and title from its
// subscription), with the request's prompt, model and capabilities in their place when it sends them.
func (p *restartPlan) restartSettings() {
	var storedFlags []string
	if ls := p.stored; ls != nil {
		storedFlags = store.UnmarshalFlags(ls.Flags)
		if ls.AgentType != "" && !sameProvider(ls.AgentType, p.agentType) {
			storedFlags = nil // a switch to another provider: the flags belong to the CLI it ran on, they do not carry (#8973)
		}
		p.prompt = ptr.Value(ls.Prompt)
		p.board = ptr.Value(ls.BoardName)
		p.boardServer = ptr.Value(ls.BoardServer)
		p.displayName = ptr.Value(ls.DisplayName)
		p.boardType = ptr.Value(ls.BoardType)
		p.model = ptr.Value(ls.Model)
		if t := ptr.Value(ls.Thinking); agentmodels.ValidThinking(p.agentType, t) { // another provider's level does not carry over
			p.thinking = t
		}
		p.thinkingFlag = ptr.Value(ls.Thinking) != ""
		p.contextWindow = ls.ContextWindow
		p.capsJSON = ls.Capabilities
		p.toolsJSON = ls.Tools
		p.tools = store.UnmarshalFlags(ls.Tools)
		// p.caps was validated and unmarshaled in restartResolve
	}
	if p.subscription != nil {
		p.board = p.subscription.Project
		if p.displayName == "" {
			p.displayName = p.subscription.JobTitle
		}
	}
	// Request body overrides stored values (user edited in modal)
	if p.req.Prompt != "" {
		p.prompt = p.req.Prompt
	}
	if p.req.Model != nil {
		if m := strings.TrimSpace(*p.req.Model); m != "" {
			p.model = m
			p.contextWindow = proxy.LookupContextWindow(m)
		} else {
			p.model = ""
			p.contextWindow = 0
		}
	}
	if p.req.Capabilities != nil {
		p.caps = p.req.Capabilities
		p.capsJSON = store.MarshalCapabilities(p.req.Capabilities)
	}
	if p.req.Thinking != nil {
		p.thinking = strings.TrimSpace(*p.req.Thinking) // checked in restartResolve
		p.thinkingFlag = true
	}
	if p.thinkingFlag {
		storedFlags = agentmodels.StripThinkingFlags(storedFlags)
	}
	if p.stored != nil && p.stored.PermissionMode != nil && *p.stored.PermissionMode != "" {
		p.permMode = *p.stored.PermissionMode
	} else {
		if perm := agent.PermissionModeFromFlags(storedFlags); perm != "" {
			p.permMode = perm
		}
	}
	if p.permMode == "" {
		// An agent from before modes were recorded, with no permission flags either: it restarts in Default, never the saved default (which may be Auto), and says so (#10297).
		if carried, _ := agent.SplitPermissionFlags(append(append([]string{}, storedFlags...), strings.Fields(p.req.ExtraFlags)...)); len(carried) == 0 {
			p.permMode = "default"
			p.modeNotRecorded = p.stored != nil
		}
	}
	cleanFlags := restartFlags(storedFlags, p.model, p.req.ExtraFlags)
	if carried, _ := agent.SplitPermissionFlags(storedFlags); p.caps.IsEmpty() && len(carried) > 0 {
		cleanFlags = append(cleanFlags, carried...) // what the agent was started with, as it was (#6423)
	} else if p.caps.IsEmpty() && p.permMode != "" && p.permMode != "default" {
		cleanFlags = append(cleanFlags, agent.PermissionFlagsForAgent(p.agentType, p.permMode)...)
	}
	p.flags = append(cleanFlags, agentmodels.ThinkingArgs(p.agentType, p.thinking)...)
}

// restartFlags is a restarted agent's CLI flags: the stored ones without permission flags (its capabilities are
// the source of truth, and LaunchCommand generates the flags for the target type: a Codex --full-auto must not
// reach Claude) and without a model, then the model, then the request's extra flags.
func restartFlags(stored []string, model, extra string) []string {
	clean := stripAgentPermissionFlags(stored)
	var flags []string
	for i := 0; i < len(clean); i++ {
		flag := clean[i]
		if flag == "--model" || flag == "-m" {
			i++ // skip the value
			continue
		}
		if strings.HasPrefix(flag, "--model=") || strings.HasPrefix(flag, "-m=") {
			continue
		}
		flags = append(flags, flag)
	}
	if modelArgs, err := agentmodels.ModelArgs(model); err == nil { // a model that is not a valid id (a hand-edited store) is not put on the command line
		flags = append(flags, modelArgs...)
	}
	cleanExtra := stripAgentPermissionFlags(strings.Fields(extra))
	return append(flags, cleanExtra...)
}

// restartCommand builds the agent's start command, before anything is touched: when it can't be built (its prompt
// or settings files can't be written, #3601 W12), the restart fails with the old agent still running. A plain
// terminal has none: its restart is a fresh shell in the same folder, as a launch of one is (isTerminal there).
// Before, the restart typed a launch command for the Claude implementation that stands in for the type into the
// shell, which ran the claude on PATH, whatever cli_path_claude said (found by the CDP gate's PATH-CLI check on a
// restarted terminal pane).
func (h *SessionsHandler) restartCommand(ctx context.Context, p *restartPlan) (string, answer) {
	if p.agentType == at.Terminal {
		return "", nil
	}
	userSettings, serr := h.launchSettings(ctx)
	if serr != nil { // never start the restarted agent on the CLI found on PATH (#4350)
		return "", func(w http.ResponseWriter) {
			writeError(w, http.StatusServiceUnavailable, "", serr.Error())
		}
	}
	permMode := p.permMode
	if permMode == "" {
		permMode = setreg.Enum(userSettings, "default_permission_mode")
	}
	cliPath, cerr := agent.LaunchCLI(userSettings, p.agentType) // a broken cli_path_<agent> refuses the restart (#115)
	if cerr != nil {
		refuse, _ := cliPathRefusal(ctx, cerr)
		return "", refuse
	}
	cmd, err := launchCommand(agent.GetAgent(p.agentType), agent.LaunchParams{
		SessionID:       p.newSessionID,
		SessionName:     p.newSessionName,
		ProtocolPath:    h.protocolPath(),
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
		return "", func(w http.ResponseWriter) { errInternalServer(w, fmt.Sprintf("launch command failed: %v", err)) }
	}
	return cmd, nil
}

// restartTerminal gives the agent its terminal under the new session name: a fresh one (on pty also for a live
// agent, whose terminal is ended once the new one runs), or on tmux the old pane respawned and renamed, with its log started and its
// title set. It returns where the start command is typed.
func (h *SessionsHandler) restartTerminal(ctx context.Context, p *restartPlan) (string, answer) {
	fail := func(msg string) answer { return func(w http.ResponseWriter) { errInternalServer(w, msg) } }
	var target string
	if p.fresh != nil || p.usePTY {
		if p.usePTY {
			if err := h.backend.Spawn(p.newSessionName, p.agentType, p.workdir, p.newSessionID, "", 200, 50); err != nil {
				return "", fail(spawnError(err).Error())
			}
			if p.pane != nil {
				// A live pty terminal: ended once its replacement runs under the new name (pty has no rename), so a
				// spawn that fails leaves the agent running. One whose process exited since it was found is ended.
				if err := h.endOldTerminal(p.pane.SessionName); err != nil && !errors.Is(err, ptymanager.ErrTerminalGone) {
					h.backend.Kill(p.newSessionName)
					return "", fail(fmt.Sprintf("pty %s failed: %v", p.verb(), err))
				}
			}
		} else {
			ptymanager.ResetAgentLog(p.newLogPath) // 0600, never through a link (#3601, W17)
			if err := h.terminal.CreateSession(ctx, p.newSessionName, p.workdir); err != nil {
				return "", fail(err.Error())
			}
			h.terminal.StartLogging(ctx, p.newSessionName, p.newLogPath)
		}
		target = p.newSessionName + ".0"
	} else {
		// Close old pipe-pane, respawn, rename
		h.terminal.StopLogging(ctx, p.pane.Target)
		if err := h.terminal.RestartPane(ctx, p.pane.Target, p.workdir); err != nil {
			return "", fail(err.Error())
		}
		if err := h.terminal.RenameSession(ctx, p.pane.SessionName, p.newSessionName); err != nil {
			return "", fail(err.Error())
		}
		target = fmt.Sprintf("%s:0.0", p.newSessionName)
		time.Sleep(h.respawnSettle())
		// Clear scrollback, create log, setup pipe-pane
		h.terminal.ClearHistory(ctx, target)
		ptymanager.ResetAgentLog(p.newLogPath) // 0600, never through a link (#3601, W17)
		h.terminal.StartLogging(ctx, target, p.newLogPath)
	}
	// Set pane title using native tmux command (avoids shell echo)
	if !p.usePTY {
		h.terminal.SetPaneTitle(ctx, target, fmt.Sprintf("%s — %s", p.folderName(), p.agentType))
	}
	return target, nil
}

// verb is what the plan does, for its messages.
func (p *restartPlan) verb() string {
	if p.resuming {
		return "resume"
	}
	return "restart"
}

// defaultPaneRespawnSettle is how long a respawned pane is given before its history is cleared and its log started; a handler's paneSettle replaces it (tests, #6991).
const defaultPaneRespawnSettle = 500 * time.Millisecond

func (h *SessionsHandler) respawnSettle() time.Duration {
	if h.paneSettle != nil {
		return *h.paneSettle
	}
	return defaultPaneRespawnSettle
}

// restartKillGrace is how long a restart or resume gives the old pty terminal to exit on SIGTERM before it is force-killed. The new terminal
// already runs, the conversation continues from the agent's transcript, and tmux's respawn is immediate: an agent that ignores SIGTERM held
// every pty restart for Kill's full 5 s (#4842). A var for the tests.
const defaultRestartKillGrace = time.Second // a handler's killGrace replaces it (tests, #6991)

func (h *SessionsHandler) restartGrace() time.Duration {
	if h.killGrace != nil {
		return *h.killGrace
	}
	return defaultRestartKillGrace
}

// endOldTerminal ends the old terminal of a restart or resume: a pty one with the short grace, any other backend as Kill does.
func (h *SessionsHandler) endOldTerminal(name string) error {
	if k, ok := h.backend.(interface {
		KillWithin(name string, grace time.Duration) error
	}); ok {
		return k.KillWithin(name, h.restartGrace())
	}
	return h.backend.Kill(name)
}

// launchSeat is the seat a restart, a resume and the auto-wake notice take: the one on the board the live row was launched on, and never another board's. Before, it was the session's NEWEST seat, so an agent the
// Operator (or the old subscribe hole) had also seated on another board came back from a restart on that board, as that seat's member, with its live row and command-line state moved there (found by
// tests/stress/run_search.sh, #11005). With a recorded board the answer is that board's seat or none: an agent that holds no seat there (it removed it, or never had one) is NOT given the newest seat of some other
// board, because that would make the foreign board its launch board for good; with no seat the restart re-seats it on the recorded board. Only a session with NO recorded board (it joined through the board API)
// keeps the newest seat.
func (h *SessionsHandler) launchSeat(ctx context.Context, stored *store.LiveSession, sessionName string) (*board.Subscriber, error) {
	if stored != nil && stored.BoardName != nil && *stored.BoardName != "" {
		return h.bs.SessionSubscription(ctx, *stored.BoardName, sessionName)
	}
	return h.bs.GetSubscriptionBySessionName(ctx, sessionName)
}

func (p *restartPlan) folderName() string { return filepath.Base(strings.TrimRight(p.workdir, "/")) }

// restartLaunch moves the board subscription to the new session, then types the start command. The new session
// holds the subscription before its process starts: its first request (a hook, a board call) carries the new
// token, and with no subscription under the new name it is refused as an agent that is not on the board
// (identity_mismatch). The identity harness saw a restarted agent's first post refused 39 ms after its launch
// command. A start command that can't be typed puts the subscription back.
func (h *SessionsHandler) restartLaunch(ctx context.Context, p *restartPlan, target, cmd string) answer {
	if sub := p.subscription; sub != nil {
		if _, err := h.bs.Subscribe(ctx, sub.Project, sub.SubscriberID, sub.JobTitle, p.newSessionName,
			sub.OriginServer, sub.ReceiveMode, sub.CanPeek == 1); err != nil {
			return func(w http.ResponseWriter) { errInternalServer(w, err.Error()) }
		}
		writeBoardStateFile(p.newSessionName, sub.Project, sub.JobTitle, h.cfg)
	}
	if cmd == "" {
		return nil
	}
	log.Printf("[launch] %s session=%s cmd=%s", p.verb(), target, cmd)
	where, what := target, "launch command failed"
	if p.usePTY {
		if pb, ok := h.backend.(*ptymanager.PTYBackend); ok && !pb.WaitReady(p.newSessionName, 5*time.Second) {
			log.Printf("[launch] pty shell not ready after 5s, sending anyway: %s", p.newSessionName)
		}
		// Route through the terminal abstraction so oversized commands use the
		// protected script handoff instead of hitting the shell's canonical
		// input limit while a fresh PTY is initializing.
		where, what = p.newSessionName, "pty launch command failed"
	}
	if err := sendLaunchCommand(ctx, h.terminal, where, cmd); err != nil {
		h.putSubscriptionBack(ctx, p.subscription)
		return func(w http.ResponseWriter) { errInternalServer(w, fmt.Sprintf("%s: %v", what, err)) }
	}
	return nil
}

// restartRecord replaces the old session with the new one in the store, carrying its settings, name, tags and
// board forward; a sleeping agent is awake now.
func (h *SessionsHandler) restartRecord(ctx context.Context, p *restartPlan) {
	// Capture shell PID for process-tree-based identity resolution
	var restartPID int
	if tmuxTerm, ok := h.terminal.(*ptymanager.TmuxSessionTerminal); ok {
		if pid, err := tmuxTerm.Client().GetPanePID(ctx, p.newSessionName); err == nil {
			restartPID = pid
			log.Printf("[launch] restart captured PID %d for session %s", pid, p.newSessionName)
		} else {
			log.Printf("[launch] restart failed to capture PID for session %s: %v", p.newSessionName, err)
		}
	}
	// An empty model is stored as "" (not NULL) and empty flags as "[]", so a cleared model or cleared flags stay
	// cleared on the next restart rather than carrying forward the prior ones.
	model, flags := ptr.NonEmpty(p.model), store.MarshalFlags(p.flags)
	if p.model == "" {
		model = new(string)
	}
	if len(p.flags) == 0 {
		empty := "[]"
		flags = &empty
	}
	h.chatMeta.forget(p.req.SessionID, p.newSessionID)
	h.ss.ReplaceLiveSession(ctx, p.req.SessionID, &store.LiveSession{
		SessionID:     p.newSessionID,
		AgentType:     p.agentType,
		AgentName:     p.folderName(),
		WorkingDir:    p.workdir,
		ResumeFromID:  ptr.NonEmpty(p.req.SessionID),
		Flags:         flags,
		Prompt:        ptr.NonEmpty(p.prompt),
		BoardName:     ptr.NonEmpty(p.board),
		BoardServer:   ptr.NonEmpty(p.boardServer),
		BoardType:     ptr.NonEmpty(p.boardType),
		Capabilities:  p.capsJSON,
		Model:         model,
		Thinking:      &p.thinking, // "" when it has none: the replaced session's level is not carried over
		ContextWindow: p.contextWindow,
		Tools:         p.toolsJSON,
		PID:           restartPID,
		PermissionMode: func() *string {
			if p.stored != nil && p.stored.PermissionMode != nil && *p.stored.PermissionMode != "" {
				return p.stored.PermissionMode
			}
			return ptr.NonEmpty(p.permMode) // the mode it restarted in is recorded, so the next restart knows it (#10297)
		}(),
	})
	h.noteLaunchedHooks(ctx, p.newSessionID, p.agentType) // #3665
	h.ss.MigrateDisplayName(ctx, p.req.SessionID, p.newSessionID)
	h.ss.MigrateSessionTags(ctx, p.req.SessionID, p.newSessionID) // and its tags (#3216)
	if p.sleeping != nil {
		// The new row inherits the sleeping flag; this agent is running now.
		h.ss.SetSessionSleeping(ctx, p.newSessionID, false)
		if bn := ptr.Value(p.sleeping.BoardName); bn != "" && h.boardHandler != nil {
			h.boardHandler.SetPaused(bn, false)
		}
	}
	// Re-subscribed in restartLaunch, before the launch; a restart with no subscription joins its board now.
	if p.subscription == nil && p.board != "" {
		h.setupBoardAndPrompt(p.newSessionID, p.newSessionName, p.agentType, p.board, p.displayName)
	}
}
