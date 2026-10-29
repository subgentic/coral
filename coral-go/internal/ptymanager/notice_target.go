package ptymanager

import (
	"context"
	"log/slog"
	"os"
	"sync"
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

// NoticeBlocked reports whether a board notice (a nudge, a notification, a task or agent UI notice: any automated text) must not be typed into the agent's terminal because its
// foreground program is not the recorded agent process. It logs once per cause, and records the skip for the dashboard (SkipNotAgent). A terminal agent is handled elsewhere; a terminal
// that cannot tell blocks nothing.
func NoticeBlocked(ctx context.Context, term any, name, agentType, sessionID, what string) (blocked bool, why string) {
	if noticeCheckOff() || IsTerminalAgent(name, agentType) {
		return false, ""
	}
	c, ok := term.(NoticeTargetChecker)
	if !ok {
		return false, ""
	}
	allowed, wait, why, known := c.AgentNoticeTarget(ctx, name, agentType, sessionID)
	if !known || allowed {
		return false, ""
	}
	if !wait { // a launch moments ago is not a pause worth showing
		if _, seen := noticeLogged.LoadOrStore(name+"\x00"+why, true); !seen {
			slog.Warn("board notices paused: not typing into a terminal that is not running the agent", "session", name, "why", why, "skipped", what)
		}
		noteSkipped(AutomatedInput{Name: name, What: what}, SkipNotAgent+" ("+why+")")
	}
	return true, why
}
