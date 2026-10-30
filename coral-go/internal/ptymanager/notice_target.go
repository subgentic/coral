package ptymanager

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// Board notices are typed only into the session's recorded agent CLI process (#389). "The agent's shell is not idle" is not enough: a nested shell, a program in it, or a CLI started
// by hand is not the agent, and text typed there is read by it or run by a shell later (#388 case 3). AgentExited (the shell is idle, so the CLI has exited) still decides the launch
// lines; this is the separate, stricter check for notices, and neither falls back to the other.

// SkipNotAgent is what the person sees on the agent's page when notices are paused (SkippedSend.Why).
const SkipNotAgent = "notices paused: this terminal is not running the agent"

// NoticeTargetChecker is implemented by terminals that can tell whether the agent's recorded process is the foreground program of its terminal (tmux; ConPTY follows).
type NoticeTargetChecker interface {
	// AgentNoticeTarget: ok is whether a notice may be typed now, wait that the agent's process is still being recorded (a launch moments ago), why the reason when not ok.
	// known is false when it cannot tell (the terminal is gone, or the platform cannot say), which blocks nothing.
	AgentNoticeTarget(ctx context.Context, name, agentType, sessionID string) (ok, wait bool, why string, known bool)
}

// watchStoppers end the watches for a launched agent's process, per backend (tmux, ConPTY): each registers one at init.
var (
	watchStopMu   sync.Mutex
	watchStoppers []func()
)

func registerWatchStopper(f func()) {
	watchStopMu.Lock()
	defer watchStopMu.Unlock()
	watchStoppers = append(watchStoppers, f)
}

// StopAgentWatches ends every running watch for an agent's process and waits for them: they are bounded but outlive the test or the server that started them. The TestMains call it before
// the goroutine check.
func StopAgentWatches() {
	watchStopMu.Lock()
	fs := append([]func(){}, watchStoppers...)
	watchStopMu.Unlock()
	for _, f := range fs {
		f()
	}
}

// noticeCheckOverride is a test seam: a test stores a value to override the environment's (a goroutine may be reading it, so it is atomic).
var noticeCheckOverride atomic.Pointer[bool]

// noticeCheckIsOff is whether the check is off now: the test override, else the environment's.
func noticeCheckIsOff() bool {
	if o := noticeCheckOverride.Load(); o != nil {
		return *o
	}
	return noticeCheckOff()
}

// noticeCheckOff: CORAL_NOTICE_TARGET_CHECK=off restores the earlier rule (a notice is typed unless the agent has exited) for the first release. Read once, logged at first use.
var noticeCheckOff = sync.OnceValue(func() bool {
	if os.Getenv("CORAL_NOTICE_TARGET_CHECK") != "off" {
		return false
	}
	slog.Warn("CORAL_NOTICE_TARGET_CHECK=off: board notices are typed into a terminal whose foreground program is not the recorded agent process (the earlier rule)")
	return true
})

// noticeLogged keeps the log of a paused notice to once per cause and session.
var noticeLogged sync.Map // session name + "\x00" + reason -> true

func init() {
	OnSessionEnd(func(name string) {
		noticeLogged.Range(func(k, _ any) bool {
			if s := k.(string); len(s) > len(name) && s[:len(name)+1] == name+"\x00" {
				noticeLogged.Delete(k)
			}
			return true
		})
	})
}

// NoticeCheckExempt is implemented by test fakes only, to say that the notice check does not apply to them: a real terminal or runtime that cannot say whether its foreground is the agent
// types nothing (NoticeBlocked fails closed), so a future backend cannot silently type everywhere.
type NoticeCheckExempt interface{ NoticeCheckNotApplicable() }

// NoticeBlocked reports whether a board notice (a nudge, a notification, a task or agent UI notice: any automated text) must not be typed into the agent's terminal because its
// foreground program is not the recorded agent process. It logs once per cause, and records the skip for the dashboard (SkipNotAgent). A terminal agent is handled elsewhere; a terminal
// that cannot tell blocks nothing. A launch moments ago is blocked too, without being shown as a pause: the sender should use NoticeBlockedWait, which holds the notice until the process is recorded.
func NoticeBlocked(ctx context.Context, term any, name, agentType, sessionID, what string) (blocked bool, why string) {
	blocked, _, why = noticeCheck(ctx, term, name, agentType, sessionID, what)
	return blocked, why
}

// noticeHoldMax and noticeHoldStep bound how long a notice for an agent that was just launched is held, and how often it is checked again (variables for tests).
var (
	noticeHoldMax  = 15 * time.Second
	noticeHoldStep = 200 * time.Millisecond
)

// NoticeBlockedWait is NoticeBlocked for a notice that must not be lost: when the only reason is that the agent's process is still being recorded (a launch moments ago), the notice is held and the check
// repeated every noticeHoldStep, up to noticeHoldMax, until the process is recorded; nothing is typed before then, so this only delays. If the record never lands the notice is withheld as before and the cause is
// logged once. The caller's goroutine waits, never the launch.
func NoticeBlockedWait(ctx context.Context, term any, name, agentType, sessionID, what string) (blocked bool, why string) {
	deadline := time.Now().Add(noticeHoldMax)
	for {
		blocked, wait, why := noticeCheck(ctx, term, name, agentType, sessionID, what)
		if !blocked || !wait {
			return blocked, why
		}
		if time.Now().Add(noticeHoldStep).After(deadline) || ctx.Err() != nil {
			return noticePaused(name, what, why, false) // the record never landed: shown and logged once, as any pause
		}
		select {
		case <-ctx.Done():
		case <-time.After(noticeHoldStep):
		}
	}
}

// noticeCheck is the check itself: blocked, and wait when the only reason is that the agent's process is still being recorded.
func noticeCheck(ctx context.Context, term any, name, agentType, sessionID, what string) (blocked, wait bool, why string) {
	if noticeCheckIsOff() || IsTerminalAgent(name, agentType) {
		return false, false, ""
	}
	c, ok := term.(NoticeTargetChecker)
	if !ok {
		if _, fake := term.(NoticeCheckExempt); fake {
			return false, false, ""
		}
		// A real terminal or runtime without the check cannot say whether the foreground is the agent: fail closed.
		b, w := noticePaused(name, what, "this terminal cannot say whether it is running the agent", false)
		return b, false, w
	}
	allowed, wait, why, known := c.AgentNoticeTarget(ctx, name, agentType, sessionID)
	if allowed {
		return false, false, ""
	}
	if !known {
		// It cannot tell (the pane is gone, the process table could not be read, or the platform does not record the agent): nothing is typed.
		b, w := noticePaused(name, what, "this terminal cannot say whether it is running the agent", false)
		return b, false, w
	}
	if wait {
		return true, true, why // held by the caller, or paused by it when the wait runs out: nothing is logged for a launch moments ago
	}
	b, w := noticePaused(name, what, why, false)
	return b, false, w
}

// noticePaused records and logs a withheld notice (once per cause) and answers "blocked". wait: the agent's process is still being recorded, which is not shown as a pause.
func noticePaused(name, what, why string, wait bool) (bool, string) {
	if !wait { // a launch moments ago is not a pause worth showing
		if _, seen := noticeLogged.LoadOrStore(name+"\x00"+why, true); !seen {
			slog.Warn("board notices paused: not typing into a terminal that is not running the agent", "session", name, "why", why, "skipped", what)
		}
		noteSkipped(AutomatedInput{Name: name, What: what}, SkipNotAgent+" ("+why+")")
	}
	return true, why
}
