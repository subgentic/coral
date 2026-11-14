package tunnel

import (
	"net/http"
	"testing"
)

// #16032: X-Coral-Hub-Server is the routed-to server id on the routes that act on one agent, and is dropped on every other request that is not already a relay.
func TestScrubForwardsTheRoutedToServerOnlyOnTheTypingRoutes(t *testing.T) {
	cases := []struct {
		method, path string
		kept         bool
	}{
		{"POST", "/api/sessions/live/worktree1/send", true},
		{"POST", "/api/sessions/live/worktree1/keys", true},
		{"POST", "/api/sessions/live/worktree1/answer-prompt", true},
		{"GET", "/api/sessions/live/worktree1/send", false},
		{"POST", "/api/sessions/live/worktree1/kill", true}, // #16074: the routes that act on one agent
		{"POST", "/api/sessions/live/worktree1/restart", true},
		{"POST", "/api/sessions/live/worktree1/goal", true},
		{"POST", "/api/sessions/live/worktree1/dismiss-wait", true},
		{"POST", "/api/sessions/live/worktree1/sleep", true},
		{"POST", "/api/sessions/live/worktree1/wake", true},
		{"POST", "/api/sessions/live/team/lab/sleep", true},
		{"POST", "/api/sessions/live/team/lab/wake", true},
		{"GET", "/api/sessions/live/worktree1/kill", false},
		{"POST", "/api/sessions/live/team/lab/extra/wake", false},
		{"POST", "/api/sessions/live/worktree1/resume", false},
		{"POST", "/api/sessions/live/worktree1/auto-sleep", false},
		{"POST", "/api/sessions/live/sleep-all", false},
		{"POST", "/api/sessions/live/worktree1/send/extra", false},
		{"POST", "/api/sessions/live/a/b/send", false},
		{"POST", "/api/sessions/live/worktree1/waiting/send", false},
		{"POST", "/api/board/team/external-messages", true}, // the relay keeps its own rule
		{"POST", "/api/board/team/messages", false},
	}
	for _, c := range cases {
		in := http.Header{}
		in.Set(HubServerHeader, "srv-1")
		got := scrub(in, c.method, c.path).Get(HubServerHeader) != ""
		if got != c.kept {
			t.Errorf("%s %s: forwarded=%v, want %v", c.method, c.path, got, c.kept)
		}
	}
}
