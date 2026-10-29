package routes

import (
	"context"
	"errors"
	"fmt"
	"github.com/subgentic/coral/internal/executil"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// ── Lifecycle ───────────────────────────────────────────────────────────

func sendLaunchCommand(ctx context.Context, terminal ptymanager.SessionTerminal, target, command string) error {
	// Read at the moment of typing, which may be a spaced start's later slot: a shell of unknown contents in the terminal (git-bash,
	// WSL) gets no launch line (Security on #216).
	if sh := ptymanager.UnknownShell(ctx, terminal, strings.TrimSuffix(target, ".0"), "", ""); sh != "" {
		return errors.New(ptymanager.UnknownShellRefusal(sh))
	}
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
		return sendLaunchCommand(h.withLaunchCLI(ctx, agentType), h.terminal, target, cmd)
	}
	log.Printf("[launch] %s: its start is typed in %s (the team's starts are spaced)", target, d.Round(100*time.Millisecond))
	h.teamSlot(d, func() {
		bg, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := sendLaunchCommand(h.withLaunchCLI(bg, agentType), h.terminal, target, cmd); err != nil {
			log.Printf("[launch] %s: the spaced start failed: %v", target, err)
		}
	})
	return nil
}

// answer writes a refused or failed request's reply; a nil answer is success so far.
type answer func(w http.ResponseWriter)

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

// storedSessionID is the id of the session a restart continues ("" when it is unknown to the store).
func storedSessionID(ls *store.LiveSession) string {
	if ls == nil {
		return ""
	}
	return ls.SessionID
}
