package background

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/tmux"
)

// reconcileMissThreshold is the number of consecutive reconcile passes an
// awake session must be missing from the runtime before it is marked as
// sleeping. A single miss can be a transient tmux hiccup rather than a crash.
const reconcileMissThreshold = 2

// orphanGracePeriod is how long after a session is marked stopped in the DB
// the reconciler waits before killing a runtime session that is still alive
// under that ID. Gives in-flight kill/restart handlers time to finish.
const orphanGracePeriod = 2 * time.Minute

// SessionReconciler periodically checks live sessions against running
// processes and marks crashed agents as sleeping. This catches agents that
// die between server restarts — without it, they stay "live" in the DB
// forever with no running process.
//
// To avoid falsely sleeping a healthy agent, a session is only marked as
// sleeping when (a) it is absent from ListAgents, (b) a direct IsAlive probe
// on its session name also fails, and (c) that happens on
// reconcileMissThreshold consecutive passes.
type SessionReconciler struct {
	sessionStore *store.SessionStore
	runtime      AgentRuntime
	interval     time.Duration
	logger       *slog.Logger
	misses       map[string]int // session_id -> consecutive passes not found
	now          func() time.Time
	// onSlept hears the sessions one pass marked sleeping (an exited CLI or a gone terminal),
	// for the exit notice (#3613). Unset: nothing is told.
	onSlept func(ctx context.Context, sessionIDs []string)
	slept   []string // this pass's
	// The watch for the terminal server going away (#12592), for a runtime that can be asked (ServerWatcher).
	onServerLost func(ctx context.Context, loss ServerLoss)
	serverUp     bool // the server was seen up and has not been reported lost since
	serverPID    int  // the last pid seen
}

// ServerWatcher is a runtime with a server process of its own that can be asked whether it is up (tmux).
type ServerWatcher interface {
	ServerState(ctx context.Context) tmux.ServerState
}

// ServerLoss is the terminal server having gone away under agents that were running: when it was found, the last pid seen, and the sessions that were awake.
type ServerLoss struct {
	At         time.Time
	PID        int
	SessionIDs []string
}

// SetOnServerLost registers f to hear a lost terminal server, once per loss.
func (r *SessionReconciler) SetOnServerLost(f func(ctx context.Context, loss ServerLoss)) {
	r.onServerLost = f
}

// watchServer reports whether the terminal server that was up on an earlier pass is gone now with agents awake. That is one event, not a miss per agent: it is logged once with the time,
// the last pid seen and how many sessions were lost, the sessions are put to sleep at once (their terminals cannot come back by waiting) and onServerLost hears it. A server never seen up, or
// an answer that cannot be told from "gone" (Known false), reports nothing.
func (r *SessionReconciler) watchServer(ctx context.Context, live []store.LiveSession) bool {
	w, ok := r.runtime.(ServerWatcher)
	if !ok {
		return false
	}
	st := w.ServerState(ctx)
	if !st.Known {
		return false
	}
	if st.Up {
		r.serverUp, r.serverPID = true, st.PID
		return false
	}
	if !r.serverUp {
		return false
	}
	var ids []string
	for _, ls := range live {
		if ls.IsSleeping == 1 {
			continue
		}
		// Read again: a person may have put it to sleep for another reason since the pass began, and that reason is kept.
		if now, err := r.sessionStore.GetLiveSession(ctx, ls.SessionID); err != nil || now == nil || now.IsSleeping == 1 {
			continue
		}
		ids = append(ids, ls.SessionID)
	}
	if len(ids) == 0 {
		r.serverUp = false // the last agent was ended on purpose: a server with no session exits by itself
		return false
	}
	r.serverUp = false
	loss := ServerLoss{At: r.now(), PID: r.serverPID, SessionIDs: ids}
	r.logger.Warn("the terminal server (tmux) is gone: its agents' terminals ended with it",
		"time", loss.At.Format(time.RFC3339), "last_pid", loss.PID, "lost_sessions", len(ids))
	for _, sid := range ids {
		if err := r.sessionStore.SetSessionSleepingFor(ctx, sid, store.SleepReasonTerminalGone); err != nil {
			r.logger.Error("failed to mark an agent of the lost terminal server as sleeping", "session_id", sid, "error", err)
		}
		delete(r.misses, sid)
	}
	if r.onServerLost != nil {
		r.onServerLost(ctx, loss)
	}
	return true
}

// SetOnSlept registers f to hear, once per pass, the agents that pass found dead.
func (r *SessionReconciler) SetOnSlept(f func(ctx context.Context, sessionIDs []string)) {
	r.onSlept = f
}

// exitedLaunchGrace is how long after launch a pane showing a shell is not yet
// taken as an exited agent: the CLI is typed into that shell and needs a moment
// to start.
const exitedLaunchGrace = time.Minute

// NewSessionReconciler creates a new SessionReconciler.
func NewSessionReconciler(ss *store.SessionStore, rt AgentRuntime, interval time.Duration) *SessionReconciler {
	return &SessionReconciler{
		sessionStore: ss,
		runtime:      rt,
		interval:     interval,
		logger:       slog.Default().With("service", "session_reconciler"),
		misses:       make(map[string]int),
		now:          time.Now,
	}
}

// Run starts the reconciliation loop.
func (r *SessionReconciler) Run(ctx context.Context) error {
	return runOnTicker(ctx, r.interval, func() { r.reconcileOnce(ctx) })
}

func (r *SessionReconciler) reconcileOnce(ctx context.Context) {
	liveSessions, err := r.sessionStore.GetAllLiveSessions(ctx)
	if err != nil {
		r.logger.Error("failed to read live sessions", "error", err)
		return
	}

	if r.watchServer(ctx, liveSessions) {
		return // one loss was reported for every agent in it: the per-agent pass has nothing to add
	}

	agents, err := r.runtime.ListAgents(ctx)
	if err != nil {
		r.logger.Error("failed to list running agents", "error", err)
		return
	}
	alive := make(map[string]bool, len(agents))
	for _, a := range agents {
		alive[strings.ToLower(a.SessionID)] = true
	}

	r.slept = r.slept[:0]
	defer func() {
		if len(r.slept) > 0 && r.onSlept != nil {
			r.onSlept(ctx, append([]string(nil), r.slept...))
		}
	}()

	seen := make(map[string]bool, len(liveSessions))
	for _, ls := range liveSessions {
		if ls.IsSleeping == 1 {
			delete(r.misses, ls.SessionID)
			r.checkResumed(ctx, ls, alive)
			continue
		}
		seen[ls.SessionID] = true
		if alive[strings.ToLower(ls.SessionID)] {
			delete(r.misses, ls.SessionID)
			r.checkExited(ctx, ls)
			continue
		}

		// Not in the discovered list — confirm with a direct probe before
		// trusting it. ListAgents parses tmux output and can miss a session
		// for reasons unrelated to the agent being dead.
		name := FormatSessionName(ls.AgentType, ls.SessionID)
		if r.runtime.IsAlive(ctx, name) {
			delete(r.misses, ls.SessionID)
			r.checkExited(ctx, ls)
			r.logger.Debug("agent missing from runtime listing but liveness probe succeeded",
				"session_id", ls.SessionID, "session_name", name)
			continue
		}

		r.misses[ls.SessionID]++
		if r.misses[ls.SessionID] < reconcileMissThreshold {
			r.logger.Info("agent not found, waiting for confirmation before marking as sleeping",
				"session_id", ls.SessionID, "agent_name", ls.AgentName,
				"misses", r.misses[ls.SessionID], "threshold", reconcileMissThreshold)
			continue
		}
		delete(r.misses, ls.SessionID)

		// Its terminal session is gone: asleep, and the dashboard says why (#3344).
		if err := r.sessionStore.SetSessionSleepingFor(ctx, ls.SessionID, store.SleepReasonTerminalGone); err != nil {
			r.logger.Error("failed to mark crashed agent as sleeping",
				"session_id", ls.SessionID, "agent_name", ls.AgentName, "error", err)
			continue
		}
		r.slept = append(r.slept, ls.SessionID)
		r.logger.Warn("detected crashed agent, marking as sleeping",
			"session_id", ls.SessionID, "agent_name", ls.AgentName)
	}

	// Forget miss counts for sessions that are no longer live.
	for sid := range r.misses {
		if !seen[sid] {
			delete(r.misses, sid)
		}
	}

	r.killOrphans(ctx, agents)
}

// killOrphans terminates runtime sessions whose DB row was marked stopped
// more than orphanGracePeriod ago. These are sessions a kill/restart missed
// (historically because the tmux pane listing was mis-parsed) and they would
// otherwise linger forever, consuming resources and confusing the sidebar.
func (r *SessionReconciler) killOrphans(ctx context.Context, agents []AgentInfo) {
	if len(agents) == 0 {
		return
	}
	ids := make([]string, 0, len(agents))
	for _, a := range agents {
		ids = append(ids, strings.ToLower(a.SessionID))
	}
	stopped, err := r.sessionStore.GetStoppedSessions(ctx, ids)
	if err != nil {
		r.logger.Error("failed to look up stopped sessions", "error", err)
		return
	}
	for _, a := range agents {
		stoppedAt, ok := stopped[strings.ToLower(a.SessionID)]
		if !ok {
			continue
		}
		if stoppedAt != "" {
			t, err := time.Parse(store.ISOFormat, stoppedAt)
			if err != nil {
				continue // unknown timestamp format — leave it alone
			}
			if time.Since(t) < orphanGracePeriod {
				continue
			}
		}
		name := FormatSessionName(a.AgentType, a.SessionID)
		if err := r.runtime.KillAgent(ctx, name); err != nil {
			r.logger.Error("failed to kill orphaned session", "session_name", name, "error", err)
			continue
		}
		r.logger.Warn("killed orphaned runtime session (marked stopped in DB but still running)",
			"session_name", name, "stopped_at", stoppedAt)
	}
}

// checkExited marks an agent sleeping once its CLI has exited and left its pane at a
// plain shell prompt (#3219): reconcileMissThreshold consecutive passes, and not in
// the first minute after launch. The shell is left as it is; Wake (or Resume) types
// the resume command into it. A 'terminal' agent, whose shell is the agent, is never
// marked.
func (r *SessionReconciler) checkExited(ctx context.Context, ls store.LiveSession) {
	name := FormatSessionName(ls.AgentType, ls.SessionID)
	// A shell of unknown contents is not "exited" here: marking the agent ended would let Wake type its launch line into it (Security on #216).
	exited, fg, _ := ptymanager.AgentExitedForLaunch(ctx, r.runtime, name, ls.AgentType, ls.SessionID)
	if !exited {
		return
	}
	if r.cliMissing(ctx, ls, name) || r.hermesGatewayRefused(ctx, ls, name) {
		return
	}
	if created, err := time.Parse(store.ISOFormat, ls.CreatedAt); err == nil && r.now().Sub(created) < exitedLaunchGrace {
		return
	}
	if err := r.sessionStore.SetSessionSleepingFor(ctx, ls.SessionID, store.SleepReasonAgentExited); err != nil {
		r.logger.Error("failed to mark exited agent as sleeping", "session_id", ls.SessionID, "error", err)
		return
	}
	r.slept = append(r.slept, ls.SessionID)
	r.logger.Warn("agent CLI has exited, marking as sleeping (Wake resumes it)",
		"session_id", ls.SessionID, "agent_name", ls.AgentName, "foreground", fg)
}

// checkResumed wakes an agent that was marked Ended (its CLI exited, reason agent_exited) when its terminal now plainly runs a program again: a person started the CLI by hand in that shell
// (#13431). It needs a positive reading (the shell's process table shows a foreground program, ptymanager.AgentRunning); a terminal that cannot be read, a gone terminal and every other
// sleep reason (a person's, auto-sleep, a lost terminal server) are left as they are.
func (r *SessionReconciler) checkResumed(ctx context.Context, ls store.LiveSession, alive map[string]bool) {
	if ls.SleepReason == nil || *ls.SleepReason != store.SleepReasonAgentExited || ls.IsArchived == 1 || !alive[strings.ToLower(ls.SessionID)] {
		return
	}
	name := FormatSessionName(ls.AgentType, ls.SessionID)
	if !ptymanager.AgentRunning(ctx, r.runtime, name, ls.AgentType, ls.SessionID) {
		return
	}
	if err := r.sessionStore.SetSessionSleeping(ctx, ls.SessionID, false); err != nil {
		r.logger.Error("failed to mark a resumed agent as awake", "session_id", ls.SessionID, "error", err)
		return
	}
	r.logger.Info("the agent's CLI runs again in its terminal, marking it awake", "session_id", ls.SessionID, "agent_name", ls.AgentName)
}

// missingCLIWindow is how long after Coral typed an agent's launch line a shell's "no such command" error for the agent's CLI counts as the launch's own: the reconciler's pass is
// every 30 seconds, so this is the first pass or two. Later the same words on a screen are an agent's own output (a transcript of a failed command) and are left alone.
const missingCLIWindow = 45 * time.Second

// cliMissing is the safety net under the CLI checks (#353): the agent's pane is at its shell, Coral typed its launch line moments ago (launched_at, which a wake sets too), and the shell's own "no such command" error for the agent's
// CLI is on the screen (a launch line typed although the CLI was nowhere, or not on the agent's shell's PATH). Conclusive at once, so the agent is marked with the reason cli_missing
// ("Failed to start", with the words the dashboard has for it) without the launch grace or the consecutive passes. It only marks: nothing is killed, relaunched or typed, and no setting
// changes. It reports whether it marked the agent.
func (r *SessionReconciler) cliMissing(ctx context.Context, ls store.LiveSession, name string) bool {
	info := agent.GetCLIInfo(ls.AgentType)
	sr, ok := r.runtime.(ptymanager.ScreenReader)
	if info == nil || info.Binary == "" || !ok {
		return false
	}
	// When Coral last typed the launch line: launched_at, which a wake stamps because it reuses the row; a launch, restart or resume makes a new row, whose created_at is that moment.
	launched, err := time.Parse(store.ISOFormat, ptr.Value(ls.LaunchedAt))
	if err != nil {
		launched, err = time.Parse(store.ISOFormat, ls.CreatedAt)
	}
	if err != nil || r.now().Sub(launched) > missingCLIWindow {
		return false
	}
	screen, err := sr.AgentScreen(ctx, name, ls.AgentType, ls.SessionID)
	if err != nil || !agent.MissingCommandIn(screen, info.Binary) {
		return false
	}
	if err := r.sessionStore.SetSessionSleepingFor(ctx, ls.SessionID, store.SleepReasonAgentExited); err != nil { // its CLI is not running: it ended
		r.logger.Error("failed to mark an agent whose CLI is missing", "session_id", ls.SessionID, "error", err)
		return false
	}
	if err := r.sessionStore.SetStartFailure(ctx, ls.SessionID, store.StartFailureCLIMissing); err != nil {
		r.logger.Error("failed to record why an agent could not start", "session_id", ls.SessionID, "error", err)
	}
	r.slept = append(r.slept, ls.SessionID)
	r.logger.Warn("the agent's shell could not find its CLI; marking it ended, failed to start", "session_id", ls.SessionID, "agent_name", ls.AgentName, "agent_type", ls.AgentType)
	return true
}

// hermesRefusalWindow is how long after Coral typed a Hermes agent's launch line its own refusal to start a gateway counts as the launch's (#12052): a new home prepares its dependencies for a minute or more first.
// Later the same words on a screen are the agent's own output.
const hermesRefusalWindow = 30 * time.Minute

// hermesGatewayRefused (and, since #12213, a first-use setup that failed) marks a Hermes agent at its shell whose gateway start Hermes refused (another gateway held the host's lock when two started together, status 75): ended, and failed to start with the
// fixed reason hermes_gateway_refused, so the dashboard says so and Wake tries again, instead of showing a live-looking agent with nothing in it. Only an agent at its shell (the caller checked) launched within
// hermesRefusalWindow; it only marks: nothing is killed, relaunched or typed. It reports whether it marked the agent.
func (r *SessionReconciler) hermesGatewayRefused(ctx context.Context, ls store.LiveSession, name string) bool {
	sr, ok := r.runtime.(ptymanager.ScreenReader)
	if ls.AgentType != at.Hermes || !ok {
		return false
	}
	launched, err := time.Parse(store.ISOFormat, ptr.Value(ls.LaunchedAt))
	if err != nil {
		launched, err = time.Parse(store.ISOFormat, ls.CreatedAt)
	}
	if err != nil || r.now().Sub(launched) > hermesRefusalWindow {
		return false
	}
	screen, err := sr.AgentScreen(ctx, name, ls.AgentType, ls.SessionID)
	if err != nil {
		return false
	}
	code, why := "", ""
	switch {
	case agent.HermesGatewayRefusedIn(screen):
		code, why = store.StartFailureHermesGateway, "Hermes refused to start its gateway (another one held the host); marking the agent ended, failed to start"
	case agent.HermesSetupFailedIn(screen): // its first-use setup could not finish and the CLI exited (#12213)
		code, why = store.StartFailureHermesSetup, "Hermes stopped during its first-use setup; marking the agent ended, failed to start"
	default:
		return false
	}
	if err := r.sessionStore.SetSessionSleepingFor(ctx, ls.SessionID, store.SleepReasonAgentExited); err != nil {
		r.logger.Error("failed to mark a Hermes agent whose gateway was refused", "session_id", ls.SessionID, "error", err)
		return false
	}
	if err := r.sessionStore.SetStartFailure(ctx, ls.SessionID, code); err != nil {
		r.logger.Error("failed to record why a Hermes agent could not start", "session_id", ls.SessionID, "error", err)
	}
	r.slept = append(r.slept, ls.SessionID)
	r.logger.Warn(why, "session_id", ls.SessionID, "agent_name", ls.AgentName)
	return true
}
