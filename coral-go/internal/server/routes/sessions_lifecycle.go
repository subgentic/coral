package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/subgentic/coral/internal/coralnames"
	"github.com/subgentic/coral/internal/executil"
	"github.com/subgentic/coral/internal/logsafe"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentmodels"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/safego"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// ── Lifecycle ───────────────────────────────────────────────────────────

func sendLaunchCommand(ctx context.Context, terminal ptymanager.SessionTerminal, target, command string) error {
	send := terminal.SendToTarget
	if q, ok := terminal.(ptymanager.QuietLauncher); ok {
		send = q.SendQuietLaunchToTarget // one short line that sources a private script, which erases the screen first (#5911); the full line is in the server's log
	}
	if err := send(ctx, terminalinput.Internal, target, command); err != nil {
		return fmt.Errorf("launch command delivery to %s failed: %w", target, err)
	}
	return nil
}

// lifecycleTimeout bounds the part of a restart, resume or wake that is past the point where it can be undone (a var for the tests).
var lifecycleTimeout = 2 * time.Minute

// lifecycleCtx is the context for the part of a restart, resume or wake that cannot be left half done (#5171): once the old terminal is ended or the new
// one made, the rest (the pane respawned and renamed, the log started, the start command typed, the store updated) must run to its end whether or not
// the dashboard is still waiting. A request that is dropped there (a reload, a tab change) used to leave the agent in neither state: the old one
// ended, the new one never started, a bare shell. Detached from the request, with its own bound, it is the old agent or the new one, never between.
func lifecycleCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return lifecycleCtxN(ctx, 0)
}

// lifecyclePerSession is what each session of a wake of many, or a team launch, adds to the bound (a var for the tests).
var lifecyclePerSession = 5 * time.Second

// lifecycleCtxN is lifecycleCtx for an action that works on n sessions one after the other: the bound grows with n, so the last of a large team is not cut off.
func lifecycleCtxN(ctx context.Context, n int) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), lifecycleTimeout+time.Duration(n)*lifecyclePerSession)
}

type tunneledKey struct{}

// viaHub marks ctx with whether the request came through Coral Hub, for answers that must not name this computer's paths.
func viaHub(ctx context.Context, r *http.Request) context.Context {
	return context.WithValue(ctx, tunneledKey{}, cloud.Tunneled(r))
}

// cliPathRefusal is the 422 answer for a CLI that can't be run: one found nowhere (cli_not_found, #5838), or a configured path that can't be run (cli_path_unusable, #115): the setting and the path, and through Coral Hub the
// setting only, as the CLI check says it. ok is false for any other error.
func cliPathRefusal(ctx context.Context, err error) (answer, bool) {
	var nf *agent.CLINotFoundError
	if errors.As(err, &nf) { // 422 cli_not_found: the install command and the setting to point at an existing install, not a server fault (#5838)
		msg := nf.Error()
		return func(w http.ResponseWriter) { writeError(w, http.StatusUnprocessableEntity, "cli_not_found", msg) }, true
	}
	var cpe *agent.CLIPathError
	if !errors.As(err, &cpe) {
		return nil, false
	}
	msg := cpe.Error()
	if hub, _ := ctx.Value(tunneledKey{}).(bool); hub {
		msg = cpe.HubText()
	}
	return func(w http.ResponseWriter) { writeError(w, http.StatusUnprocessableEntity, "cli_path_unusable", msg) }, true
}

// launchErrText is a launch error's text for an answer: a configured CLI path that can't be run names the setting only when the request came
// through Coral Hub (#115); any other error is its own text.
func launchErrText(ctx context.Context, err error) string {
	var cpe *agent.CLIPathError
	if hub, _ := ctx.Value(tunneledKey{}).(bool); hub && errors.As(err, &cpe) {
		return cpe.HubText()
	}
	return err.Error()
}

// beginRestart takes the session's turn (h.restarting: the sessions with a restart or resume running now, by name) and says whether it was free; the caller
// ends it with the returned func. A second request for one of them (a double click, a client that retries while the first still runs, now that the first
// no longer ends with its request) is refused, so one agent starts, not two (#5213).
func (h *SessionsHandler) beginRestart(name string) (end func(), ok bool) {
	if _, busy := h.restarting.LoadOrStore(name, struct{}{}); busy {
		return nil, false
	}
	return func() { h.restarting.Delete(name) }, true
}

func refuseRestartBusy(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "this agent is already being restarted; wait for it to finish", "in_progress": true})
}

// defaultAfterTeamSlot runs f once d has passed. A test replaces it for the whole package once, before any test runs (main_test.go); a test about the spacing sets the handler's own afterTeamSlotFn (#6991).
var defaultAfterTeamSlot = func(d time.Duration, f func()) { time.AfterFunc(d, f) }

// teamSlot runs f once d has passed, as this handler's afterTeamSlotFn says, else the default.
func (h *SessionsHandler) teamSlot(d time.Duration, f func()) {
	if h.afterTeamSlotFn != nil {
		h.afterTeamSlotFn(d, f)
		return
	}
	defaultAfterTeamSlot(d, f)
}

// codexFirstStartGap is how long the first Codex start on a Codex home that has never completed a turn protects itself (#6364): Codex migrates its memories database when it starts, and a second
// Codex started on the same new home in the middle of that migration exits with "failed to migrate memories DB ... table stage1_outputs already exists". A var so a test can set it (the package's
// TestMain sets it to zero: every test that launches Codex shares one home).
// 3 s: the migration is done a fraction of a second after the first Codex starts (a real Codex's memories database exists 0.3 s after its exec, #6374) and team launches already space members 2.5 s apart without
// ever hitting the race; the race came from two separate launches at the same moment. 3 s is ten times what was measured, and costs the second Codex of a first launch about 3 s, not 10.
const codexFirstStartGapDefault = 3 * time.Second

var codexFirstStartGap = codexFirstStartGapDefault

var codexFirstStarts = struct {
	sync.Mutex
	at map[string]time.Time // by Codex home: when the first start on it was typed
}{at: map[string]time.Time{}}

// reserveCodexFirstStart says how long a Codex start waits so it does not run with the first one on a new Codex home. The first Codex start on a home with no sessions folder (Codex makes it with the
// first turn it takes) goes at once and is remembered; every other start on that home waits until codexFirstStartGap after it, all together, since the migration is then done. A home that has sessions
// (it has been used), another agent type, and a zero gap are never delayed.
func reserveCodexFirstStart(agentType string, now time.Time) time.Duration {
	if agentType != at.Codex || codexFirstStartGap <= 0 {
		return 0
	}
	sessions := (&agent.CodexAgent{}).HistoryBasePath()
	home := filepath.Dir(sessions)
	if _, err := os.Stat(sessions); err == nil {
		return 0
	}
	codexFirstStarts.Lock()
	defer codexFirstStarts.Unlock()
	first, ok := codexFirstStarts.at[home]
	if !ok {
		codexFirstStarts.at[home] = now
		return 0
	}
	if d := first.Add(codexFirstStartGap).Sub(now); d > 0 {
		return d
	}
	return 0
}

// startAgentCLI types an agent's start command (its CLI, or its resume) into its terminal. The
// starts of one team are 2-3 s apart (#3613: each starts an API turn at once): the team's first
// is typed now; a later one is typed when its slot comes, on a background context, and this
// returns at once. A launch, team launch or wake request never waits for the spacing, so the
// hub's response deadline can't cut a team launch in half (Security's MUST); the terminal and
// the session already exist, and the dashboard shows each agent start.
func (h *SessionsHandler) startAgentCLI(ctx context.Context, team, agentType, target, cmd string) error {
	d := ptymanager.ReserveTeamStart(team)
	if g := reserveCodexFirstStart(agentType, time.Now()); g > d {
		d = g
	}
	if g := agent.ReserveStart(agentType); g > d { // Codex starts are spaced like a scheduled run's (two at once raced its shared state database, #6848): typed later, this returns now
		d = g
	}
	if d <= 0 {
		return sendLaunchCommand(ctx, h.terminal, target, cmd)
	}
	log.Printf("[launch] %s: its start is typed in %s (the team's starts are spaced)", target, d.Round(100*time.Millisecond))
	h.teamSlot(d, func() {
		bg, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := sendLaunchCommand(bg, h.terminal, target, cmd); err != nil {
			log.Printf("[launch] %s: the spaced start failed: %v", target, err)
		}
	})
	return nil
}

// answer writes a refused or failed request's reply; a nil answer is success so far.
type answer func(w http.ResponseWriter)

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
		p.subscription, _ = h.bs.GetSubscriptionBySessionName(ctx, naming.SessionName(storedAgentType, targetSID))
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

// Attach opens a native terminal attached to the tmux session.
// POST /api/sessions/live/{name}/attach
func (h *SessionsHandler) Attach(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct {
		AgentType string `json:"agent_type"`
		SessionID string `json:"session_id"`
	}
	decodeJSON(r, &body)
	if namesNoSession(name, body.SessionID) {
		writeSessionIDRequired(w)
		return
	}

	pane, _ := h.terminal.FindSession(r.Context(), name, body.AgentType, body.SessionID)
	if pane == nil {
		errNotFound(w, "Pane not found")
		return
	}

	// Open Terminal.app attached to the tmux session (macOS)
	attachCmd := h.terminal.AttachCommand(pane.SessionName)
	go func() {
		defer safego.Recover("server/routes/sessions_lifecycle:840")
		_ = executil.Run(osascriptTimeout, "osascript", terminalAttachArgs(attachCmd)...)
	}()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// osascriptTimeout bounds the Terminal attach: a macOS automation-permission dialog that nobody
// answers must not hold the process and its goroutine for good (#3999).
var osascriptTimeout = 30 * time.Second

// Pass the shell command as data, so quotes and backslashes in app paths never
// become AppleScript source.
func terminalAttachArgs(command string) []string {
	return []string{"-e", `on run argv
    tell application "Terminal" to do script (item 1 of argv)
end run`, "--", command}
}

// KillTeam kills all agents in a team, atomically marking active members as stopped.
// POST /api/sessions/live/team/{boardName}/kill
func (h *SessionsHandler) KillTeam(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	boardName := urlParam(r, "boardName")
	ctx := r.Context()
	bgCtx := context.Background()

	// Get all sessions on this board
	sessions, err := h.ss.GetBoardSessions(ctx, boardName)
	if err != nil {
		errInternalServer(w, "failed to get board sessions: "+err.Error())
		return
	}

	// Atomically stop the team record (snapshots active members with same stopped_at)
	teamWorktree, teamRepo := "", ""
	if h.teamStore != nil {
		if team, err := h.teamStore.GetTeam(ctx, boardName); err == nil && team != nil {
			h.teamStore.StopTeam(ctx, team.ID)
			if team.IsWorktree == 1 && team.WorkingDir != "" {
				teamWorktree = team.WorkingDir
				var cfg struct {
					WorkingDir string `json:"working_dir"`
				}
				json.Unmarshal([]byte(team.ConfigJSON), &cfg)
				teamRepo = cfg.WorkingDir
			}
		}
	}

	// Kill each session
	killed := 0
	for _, ls := range sessions {
		if ls.AgentType != at.Terminal {
			artifactCtx, cancel := context.WithTimeout(bgCtx, 30*time.Second)
			if _, err := h.persistSessionChanges(artifactCtx, ls.SessionID, ls.WorkingDir); err != nil && !errors.Is(err, errNoGitCheckout) {
				slog.Warn("persist team session changes artifact failed", "session_id", ls.SessionID, "error", err)
			}
			cancel()
		}
		h.chatMeta.forget(ls.SessionID)
		h.ss.UnregisterLiveSession(bgCtx, ls.SessionID)
		h.terminal.KillSession(ctx, ls.AgentName, ls.AgentType, ls.SessionID)
		removeBoardStateFile(ls.AgentName, h.cfg)
		agent.CleanupTempFiles(ls.SessionID)
		killed++
	}

	// Artifact snapshots above have finished: the owned worktree goes only if nothing in it is unsaved, and the answer says what was kept and why (#6701).
	resp := map[string]any{"ok": true, "sessions_killed": killed}
	if teamWorktree != "" {
		resp["worktree"] = h.removeOwnedWorktree(bgCtx, "kill-team", teamRepo, teamWorktree, coralnames.TeamBranch(filepath.Base(teamWorktree)))
	}

	// Unpause board
	if h.boardHandler != nil {
		h.boardHandler.SetPaused(boardName, false)
	}

	writeJSON(w, http.StatusOK, resp)
}

// teamBranchOf is the branch a team's worktree is on when path is one Coral made for a team (a folder directly in its worktrees folder), else "": the single kill of the last agent in
// it takes the branch with the worktree when nothing is on it, as a team stop does (QA's #6722).
func (h *SessionsHandler) teamBranchOf(path string) string {
	if !coralnames.InWorktreesRoot(h.cfg.CoralDir(), path) {
		return ""
	}
	return coralnames.TeamBranch(filepath.Base(path))
}

// removeOwnedWorktree takes a stopped agent's or team's worktree away when nothing in it is unsaved and answers what happened ({state, path, branch, reason}): the worktree and its work are never deleted
// without asking (#6701). Git runs in the owning repository, bounded at 30 s.
func (h *SessionsHandler) removeOwnedWorktree(ctx context.Context, who, repo, path, branch string) gitutil.WorktreeOutcome {
	wtCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	outcome, err := gitutil.RemoveWorktree(wtCtx, repo, path, branch)
	if err != nil {
		outcome.State, outcome.Reason = "failed", "git could not find its repository"
		log.Printf("[%s] failed to remove worktree %s: %s", who, logsafe.Dir(path), err)
	} else {
		log.Printf("[%s] worktree %s: %s %s", who, logsafe.Dir(path), outcome.State, outcome.Reason)
	}
	return outcome
}

// ResurrectTeam relaunches a stopped team with only the agents that were active at kill time.
// POST /api/teams/detail/{name}/resurrect
func (h *SessionsHandler) ResurrectTeam(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		errBadRequest(w, "team name required")
		return
	}
	if h.teamStore == nil {
		errInternalServer(w, "team persistence not available")
		return
	}

	ctx := r.Context()
	team, err := h.teamStore.GetTeam(ctx, name)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if team == nil {
		errNotFound(w, "team not found")
		return
	}
	if team.Status != "stopped" {
		errBadRequest(w, "can only resurrect stopped teams (current status: "+team.Status+")")
		return
	}

	// Get members whose stopped_at matches the team's — these were active at kill time
	members, err := h.teamStore.GetMembersForResurrect(ctx, team.ID)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if len(members) == 0 {
		errBadRequest(w, "no members eligible for resurrection")
		return
	}

	// The team record stays "stopped" until its members are launched, so the kept-worktrees list is told the resurrect is under way: a clean worktree it has just recreated must not be removed before the first
	// member registers (#6959).
	resurrectLock := teamLock(team.ID) // Remove of this team's worktree and this resurrect do not interleave (#6977)
	resurrectLock.Lock()
	defer resurrectLock.Unlock()
	if fresh, ferr := h.teamStore.GetTeamByID(ctx, team.ID); ferr != nil || fresh == nil || fresh.Status != "stopped" { // checked again under the lock: a resurrect that ran while this one waited has relaunched the members (#6977)
		errBadRequest(w, "can only resurrect stopped teams (it is being or has been resurrected)")
		return
	}
	defer beginTeamResurrect(team.ID)()

	// Recreate worktree if team had one
	workingDir := team.WorkingDir
	resurrectRepo := "" // the repository of the team's worktree, for its members' rows
	if team.IsWorktree == 1 {
		// Parse base_branch from stored config
		var cfg struct {
			BaseBranch string `json:"base_branch"`
			WorkingDir string `json:"working_dir"`
		}
		json.Unmarshal([]byte(team.ConfigJSON), &cfg)
		repoDir := cfg.WorkingDir
		if repoDir == "" {
			repoDir = filepath.Dir(team.WorkingDir)
		}
		branch, err := gitutil.ResolveBase(ctx, repoDir, cfg.BaseBranch) // the stored base, else the repository's current branch (#6701)
		if err != nil {
			errBadRequest(w, "failed to recreate worktree: "+err.Error())
			return
		}
		resurrectRepo = repoDir
		if err := gitutil.ValidRef(branch); err != nil { // a stored config is checked again (#3601, W24)
			errBadRequest(w, "the team's base_branch: "+err.Error())
			return
		}

		if !coralnames.InWorktreesRoot(h.cfg.CoralDir(), team.WorkingDir) { // a stored folder is checked again: only Coral's own worktrees folder
			errBadRequest(w, "failed to recreate worktree: the team's folder is not in Coral's worktrees folder")
			return
		}
		// On the team's own branch (coral-team/<board slug>, as the launch made it), not on the base branch itself: that one is checked out in the repository (#6701).
		if _, err := gitutil.AddTeamWorktree(ctx, repoDir, team.WorkingDir, coralnames.TeamBranch(filepath.Base(team.WorkingDir)), branch); err != nil {
			errBadRequest(w, "failed to recreate worktree: "+err.Error())
			return
		}
		log.Printf("[resurrect] recreated worktree at %s (branch %s)", logsafe.Dir(team.WorkingDir), branch)
		if afterResurrectWorktreeHook != nil {
			afterResurrectWorktreeHook()
		}
	}

	// Relaunch each member
	var launched []map[string]any
	for _, m := range members {
		var agentCfg struct {
			Name         string                 `json:"name"`
			Prompt       string                 `json:"prompt"`
			Capabilities *agent.Capabilities    `json:"capabilities"`
			AgentType    string                 `json:"agent_type"`
			Model        string                 `json:"model"`
			Tools        []string               `json:"tools"`
			Hooks        map[string]interface{} `json:"hooks"`
		}
		if err := json.Unmarshal([]byte(m.AgentConfigJSON), &agentCfg); err != nil {
			log.Printf("[resurrect] failed to parse agent config for %s: %v", m.AgentName, err)
			launched = append(launched, map[string]any{"name": m.AgentName, "error": "invalid agent config"})
			continue
		}

		agentType := agentCfg.AgentType
		if agentType == "" {
			agentType = "claude"
		}

		// Inject distilled knowledge if available
		resurrectPrompt := InjectKnowledgeIntoPrompt(h.cfg.CoralDir(), team.Name, m.AgentName, agentCfg.Prompt)

		result, err := h.launchSession(ctx, launchSpec{
			WorkDir: workingDir, AgentType: agentType, DisplayName: m.AgentName, Prompt: resurrectPrompt, BoardName: team.Name,
			Model: agentCfg.Model, Capabilities: agentCfg.Capabilities, Tools: agentCfg.Tools, Hooks: agentCfg.Hooks,
		})
		if err != nil {
			log.Printf("[resurrect] failed to launch %s: %v", m.AgentName, err)
			launched = append(launched, map[string]any{"name": m.AgentName, "error": err.Error()})
			continue
		}

		sessionID := result["session_id"].(string)

		// Update team member: active, new session_id
		h.teamStore.UpdateMemberStatus(ctx, m.ID, "active", &sessionID)
		h.ss.SetTeamID(ctx, sessionID, team.ID)
		if team.IsWorktree == 1 { // a resurrected member is in the team's worktree like a launched one: its row names it, so a stop or a kill finds it (#6817)
			h.ss.UpdateWorktreeInfo(ctx, sessionID, team.WorkingDir, resurrectRepo)
			h.recordWorktreeRow(ctx, sessionID, team.WorkingDir)
		}

		// Setup board subscription
		h.setupBoardAndPrompt(sessionID, result["session_name"].(string),
			agentType, team.Name, launchedName(result, m.AgentName))

		launched = append(launched, map[string]any{
			"name": launchedName(result, m.AgentName), "session_id": sessionID, "session_name": result["session_name"],
		})
	}

	// Update team status to running
	h.teamStore.UpdateTeamStatus(ctx, team.ID, "running")

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"team_id":     team.ID,
		"board":       team.Name,
		"board_id":    team.Name, // as launch-team answers: the board's id (a team is named by it, #6861)
		"board_label": h.boardLabel(team.Name),
		"agents":      launched,
	})
}

// storedSessionID is the id of the session a restart continues ("" when it is unknown to the store).
func storedSessionID(ls *store.LiveSession) string {
	if ls == nil {
		return ""
	}
	return ls.SessionID
}
