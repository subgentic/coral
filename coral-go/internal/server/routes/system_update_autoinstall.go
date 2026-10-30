package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/updatecheck"
)

// Install when idle (#11170, the Operator's decision of 2026-10-29): a verified update that is strictly newer than the installed Coral is installed by Coral itself once it has been idle. It
// is the click's own apply (UpdateRelaunchHandler's Updater.Apply: the updater verifies again, copies, checks, and the server ends itself once the new install is ready, agents in tmux keep
// running, and a failed apply starts the old Coral again and says why in the updater's history, #11151 and #11155). Idle is: no agent working, no automated input in flight and nobody typing
// in the dashboard for a few minutes, held for a few minutes and looked at again just before the apply. A failed apply is not retried in a loop: the version waits a day, and the pill says why.
// Windows installs ask a person (UAC) and stay click-to-install; the Hub's own relaunch is as it was.

// autoAttemptResult is the result word of an attempt that has started and has not been seen to end.
const autoAttemptResult = "did not finish"

// autoInstallFile is where the failure of the last automatic install is kept (a restart does not clear the day's wait).
const autoInstallFile = "auto_install.json"

// The states the status reports (auto_install.state).
const (
	autoOff     = "off"     // the setting is off: only the click installs
	autoWaiting = "waiting" // a verified update is waiting for Coral to be idle, or to be allowed
	autoSoon    = "soon"    // idle now: held a few minutes, then installed
	autoBackoff = "backoff" // an automatic install failed: not tried again before retry_at
	autoStarted = "started" // the apply was started
	autoNone    = "none"    // nothing to install by itself (nothing staged, or this install cannot)
)

// autoInstallTimes are the rule's timings (the defaults unless a test says otherwise).
type autoInstallTimes struct {
	Every       time.Duration // how often the job looks
	IdleFor     time.Duration // Coral idle this long before the install starts
	PersonQuiet time.Duration // nobody typed in the dashboard for this long
	Backoff     time.Duration // after a failed automatic install
}

func defaultAutoInstallTimes() autoInstallTimes {
	return autoInstallTimes{Every: 30 * time.Second, IdleFor: 5 * time.Minute, PersonQuiet: 5 * time.Minute, Backoff: 24 * time.Hour}
}

// autoInstallState is the job's memory: since when Coral has been idle, what it last said and the last failure.
type autoInstallState struct {
	mu        sync.Mutex
	idleSince time.Time
	last      AutoInstallFacts
	logged    string             // the reason last logged, so a wait is one line and not one per look
	failure   autoInstallFailure // the last failure, kept here too so a file that cannot be written does not turn the day's wait into a loop
}

// AutoInstallFacts is what the status says about the automatic install: the pill reads it.
type AutoInstallFacts struct {
	On      bool      `json:"on"`
	State   string    `json:"state"`
	Reason  string    `json:"reason,omitempty"` // why it waits, in words
	RetryAt time.Time `json:"retry_at,omitzero"`
}

// autoInstallFailure is the file: the version an automatic install failed for, when, and the updater's word for it.
type autoInstallFailure struct {
	Version  string    `json:"version"`
	FailedAt time.Time `json:"failed_at"`
	Result   string    `json:"result"`
}

func (h *UpdateRelaunchHandler) autoTimes() autoInstallTimes {
	if h.AutoTimes != nil {
		return *h.AutoTimes
	}
	return defaultAutoInstallTimes()
}

func (h *UpdateRelaunchHandler) readAutoFailure() (autoInstallFailure, bool) {
	h.auto.mu.Lock()
	mem := h.auto.failure
	h.auto.mu.Unlock()
	var f autoInstallFailure
	b, err := h.readPrivate(autoInstallFile, 4096)
	if err != nil || json.Unmarshal(b, &f) != nil || f.Version == "" {
		return mem, mem.Version != ""
	}
	if mem.Version == f.Version && mem.FailedAt.After(f.FailedAt) {
		return mem, true
	}
	return f, true
}

func (h *UpdateRelaunchHandler) writeAutoFailure(f autoInstallFailure) {
	h.auto.mu.Lock()
	h.auto.failure = f
	h.auto.mu.Unlock()
	b, err := json.Marshal(f)
	if err == nil {
		if err = h.ensureDir(); err == nil {
			err = h.writePrivate(autoInstallFile, b)
		}
	}
	if err != nil {
		slog.Warn("[update] could not record the failed automatic install", "error", err)
	}
}

// RunAutoInstall is the job: it looks every few seconds and installs a waiting update when Coral has been idle. It returns at once without an updater.
func (h *UpdateRelaunchHandler) RunAutoInstall(ctx context.Context) {
	if !h.localOn() {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(h.autoTimes().Every):
		}
		h.AutoInstallTick(ctx)
	}
}

// AutoInstallFactsNow is the last thing the job said, for the status.
func (h *UpdateRelaunchHandler) AutoInstallFactsNow(ctx context.Context) AutoInstallFacts {
	h.auto.mu.Lock()
	f := h.auto.last
	h.auto.mu.Unlock()
	if s, err := h.Settings(ctx); err == nil {
		f.On = setreg.Bool(s, setreg.UpdateAutoInstall)
		if !f.On {
			f.State, f.Reason = autoOff, ""
		}
	}
	if f.State == "" {
		f.State = autoNone
	}
	return f
}

func (h *UpdateRelaunchHandler) say(f AutoInstallFacts) AutoInstallFacts {
	h.auto.mu.Lock()
	defer h.auto.mu.Unlock()
	h.auto.last = f
	if f.State == autoBackoff || f.State == autoStarted || f.State == autoNone {
		h.auto.idleSince = time.Time{} // the hold starts over once it may try again
	}
	key := f.State + "|" + f.Reason
	if key != h.auto.logged && f.State != autoNone && f.State != autoOff {
		h.auto.logged = key
		slog.Info("[update] automatic install", "state", f.State, "why", f.Reason)
	}
	if f.State == autoNone || f.State == autoOff {
		h.auto.logged = ""
	}
	return f
}

// AutoInstallTick is one look. It returns what it decided (the tests read it).
func (h *UpdateRelaunchHandler) AutoInstallTick(ctx context.Context) AutoInstallFacts {
	times := h.autoTimes()
	s, err := h.Settings(ctx)
	if err != nil || !setreg.Bool(s, setreg.UpdateAutoInstall) {
		h.auto.mu.Lock()
		h.auto.idleSince = time.Time{}
		h.auto.mu.Unlock()
		return h.say(AutoInstallFacts{On: false, State: autoOff})
	}
	v, err := h.view(ctx, localIdentity)
	if err != nil {
		return h.say(AutoInstallFacts{On: true, State: autoNone})
	}
	// An attempt this process started that has ended without an update is a failure: it waits the day.
	h.noteAutoOutcome(v, times)
	// An attempt that did not finish (this process's, or one before a restart: the attempt is on disk from the moment it starts) is said before anything else, so the control shows why and not "an
	// install is already under way" (QA's #11170 SHOULD); a Coral that came back with the same update still staged does not try it again inside the day.
	if v.reason != reasonApplying && v.version != "" {
		if f, ok := h.readAutoFailure(); ok && f.Version == v.version && h.now().Sub(f.FailedAt) < times.Backoff && !(f.Result == autoAttemptResult && h.startedVersion == v.version && v.rec.State == updApplying) {
			return h.say(AutoInstallFacts{On: true, State: autoBackoff, Reason: "the last automatic install did not finish (" + f.Result + "); Coral tries again after a day, or use Update and relaunch", RetryAt: f.FailedAt.Add(times.Backoff)})
		}
	}
	switch v.reason {
	case "":
	case reasonNothing, reasonNotVerified, reasonUnsupported, reasonNoRunRecord:
		return h.say(AutoInstallFacts{On: true, State: autoNone})
	case reasonLocalApproval:
		return h.say(AutoInstallFacts{On: true, State: autoWaiting, Reason: "this computer asks for approval when it installs: click Update and relaunch"})
	default:
		return h.say(AutoInstallFacts{On: true, State: autoWaiting, Reason: "an update is already being installed or was just started"})
	}
	// Strictly newer than the installed one (the updater re-verifies it too, but only after the server has quit for it).
	if !updatecheck.Newer(v.version, v.rec.Installed) {
		return h.say(AutoInstallFacts{On: true, State: autoNone})
	}
	if why := h.busyReason(ctx, times); why != "" {
		h.auto.mu.Lock()
		h.auto.idleSince = time.Time{}
		h.auto.mu.Unlock()
		return h.say(AutoInstallFacts{On: true, State: autoWaiting, Reason: why})
	}
	h.auto.mu.Lock()
	if h.auto.idleSince.IsZero() {
		h.auto.idleSince = h.now()
	}
	idleFor := h.now().Sub(h.auto.idleSince)
	h.auto.mu.Unlock()
	if idleFor < times.IdleFor {
		return h.say(AutoInstallFacts{On: true, State: autoSoon, Reason: fmt.Sprintf("Coral has been idle for %d min; it installs after %d", int(idleFor/time.Minute), int(times.IdleFor/time.Minute))})
	}
	return h.applyWhenStillIdle(ctx, times)
}

// busyReason is why Coral is not idle, or "": an agent working, automated input in flight, or someone typing in the dashboard.
func (h *UpdateRelaunchHandler) busyReason(ctx context.Context, times autoInstallTimes) string {
	// What the click shows the person to acknowledge: the sessions this Coral runs itself (pty) that the relaunch ends. They have no acknowledgement here, so the update waits for the click (Security's
	// and QA's #11170 SHOULD). Agents running in tmux survive, unless this update replaces tmux itself.
	if h.Agents != nil {
		ag, err := h.Agents(ctx)
		if err != nil {
			return "the sessions that would restart could not be read"
		}
		if n := len(ag); n > 0 {
			return fmt.Sprintf("%d session%s on this Coral's own terminals would be restarted: click Update and relaunch to choose when", n, map[bool]string{true: "s", false: ""}[n != 1])
		}
	}
	if rec, err := h.Updater.Record(ctx); err == nil && rec.TmuxAgentsRestart {
		return "this update also restarts the agents running in tmux: click Update and relaunch to choose when"
	}
	if h.Work != nil {
		if why := h.Work(); why != "" {
			return why
		}
	}
	if h.Idle != nil {
		if why := h.Idle(ctx); why != "" {
			return why
		}
	}
	if h.InFlight != nil && h.InFlight() {
		return "Coral is typing a message into an agent"
	}
	if h.LastPerson != nil {
		if at := h.LastPerson(); !at.IsZero() && h.now().Sub(at) < times.PersonQuiet {
			return fmt.Sprintf("someone typed to an agent %d min ago", int(h.now().Sub(at)/time.Minute))
		}
	}
	return ""
}

// applyWhenStillIdle looks again just before the apply, and starts it with the click's own bookkeeping.
func (h *UpdateRelaunchHandler) applyWhenStillIdle(ctx context.Context, times autoInstallTimes) AutoInstallFacts {
	if why := h.busyReason(ctx, times); why != "" {
		h.auto.mu.Lock()
		h.auto.idleSince = time.Time{}
		h.auto.mu.Unlock()
		return h.say(AutoInstallFacts{On: true, State: autoWaiting, Reason: why})
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	v, err := h.view(ctx, localIdentity)
	if err != nil || v.reason != "" {
		return h.say(AutoInstallFacts{On: true, State: autoNone})
	}
	if h.startedVersion != "" && h.startedVersion == v.version {
		return h.say(AutoInstallFacts{On: true, State: autoStarted})
	}
	if !h.startedAt.IsZero() && h.now().Sub(h.startedAt) < relaunchSpacing {
		return h.say(AutoInstallFacts{On: true, State: autoWaiting, Reason: "an install was started a moment ago"})
	}
	op, err := h.Updater.Apply(ctx, "auto")
	if err != nil {
		slog.Warn("[update] the automatic install did not start", "error", err)
		h.auditAs(ctx, localIdentity, &v, "auto_failed_to_start", "auto")
		h.writeAutoFailure(autoInstallFailure{Version: v.version, FailedAt: h.now(), Result: "did not start"})
		return h.say(AutoInstallFacts{On: true, State: autoBackoff, Reason: "the install could not be started; Coral tries again after a day", RetryAt: h.now().Add(times.Backoff)})
	}
	h.startedVersion, h.startedAt = v.version, h.now()
	// On disk from the start: an attempt counts as one that did not finish unless the update replaced Coral. A Coral that comes back with the same update staged (the updater started the old one again,
	// #11155) finds it and waits the day, instead of trying again when the spacing is over.
	h.writeAutoFailure(autoInstallFailure{Version: v.version, FailedAt: h.now(), Result: autoAttemptResult})
	h.auditAs(ctx, localIdentity, &v, "auto_started", "auto")
	slog.Info("[update] installing by itself: Coral is idle", "version", v.version, "operation", printable(op, 64))
	return h.say(AutoInstallFacts{On: true, State: autoStarted})
}

// noteAutoOutcome: an install this process started that has ended without Coral being replaced (the updater recorded a result for it, and nothing is applying) failed; the version waits the
// day and the updater's history already says why (#11155).
func (h *UpdateRelaunchHandler) noteAutoOutcome(v relaunchView, times autoInstallTimes) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.startedVersion == "" || v.rec.State == updApplying || v.rec.LastResult == nil || !v.rec.LastResult.At.After(h.startedAt) {
		return
	}
	res := v.rec.LastResult.Result
	if res == "" {
		res = "failed"
	}
	h.writeAutoFailure(autoInstallFailure{Version: h.startedVersion, FailedAt: h.now(), Result: printable(strings.TrimSpace(res), 40)})
	h.startedVersion = ""
}

// UpdateIdleReason is why an agent keeps the install-when-idle rule waiting: one that is working (a turn going on, however long ago its last event: InTurn), by its name; "" when every agent is
// idle, waiting for its person, or asleep (#11170).
func (h *SessionsHandler) UpdateIdleReason(ctx context.Context) string {
	live, err := h.ss.GetAllLiveSessions(ctx)
	if err != nil {
		return "the agents could not be read"
	}
	var working []string
	ends := TerminalKind(h.terminal) != "tmux" // a tmux Coral keeps its terminals running through a relaunch; any other (pty, or one not known) ends them
	for _, l := range live {
		if l.IsSleeping == 1 || l.IsArchived == 1 {
			continue
		}
		if l.AgentType == at.Terminal && ends && !(l.Backend != nil && *l.Backend == "tmux") {
			// A plain terminal has no turns, but on a pty Coral the relaunch ends it and it cannot resume (a build, an ssh session, a REPL are lost): it is not idle (QA's #11170 MUST).
			working = append(working, "a terminal is open")
			continue
		}
		if st := h.deriveSingleSessionState(ctx, l.SessionID, 0); st.Working || st.InTurn && !st.NeedsInput {
			name := l.AgentName
			if l.DisplayName != nil && *l.DisplayName != "" {
				name = *l.DisplayName
			}
			working = append(working, name)
		}
	}
	switch len(working) {
	case 0:
		return ""
	case 1:
		if strings.HasPrefix(working[0], "a terminal") {
			return working[0]
		}
		return working[0] + " is working"
	}
	return fmt.Sprintf("%d agents are working", len(working))
}
