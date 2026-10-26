package routes

import (
	"fmt"
	"sync"
	"testing"

	"github.com/subgentic/coral/internal/ptymanager"
)

// #4057: the routes' per-session log memos (an exited agent's skipped input, keyed by session
// id or name; a terminal agent's; a refused board notice, per board and session) are
// forgotten when the session ends, so after N sessions start and end they are back to their
// starting size.
func TestSessionMemosForgottenAtSessionEnd(t *testing.T) {
	size := func(m *sync.Map) int {
		n := 0
		m.Range(func(_, _ any) bool { n++; return true })
		return n
	}
	maps := map[string]*sync.Map{"exitLogged": &exitLogged, "terminalLogged": &terminalLogged, "refusedNotices": &refusedNotices, "openRequests": &openRequests}
	start := map[string]int{}
	for k, m := range maps {
		start[k] = size(m)
	}
	name := func(i int) (string, string) {
		sid := fmt.Sprintf("aaaaaaaa-4057-4000-8000-%012d", i)
		return "claude-" + sid, sid
	}
	for i := 0; i < 50; i++ {
		n, sid := name(i)
		exitLogged.Store(sid, true) // keyed by id when the caller has one
		exitLogged.Store(n, true)   // by name when it doesn't
		terminalLogged.Store(sid, true)
		openRequests.Store(sid, true) // a session killed with a request open never sends the event that closes it (#7462)
		refusedNotices.Store("team-a\x00"+n, true)
		refusedNotices.Store("team-b\x00"+n, true)
	}
	for i := 0; i < 50; i++ {
		n, _ := name(i)
		ptymanager.ForgetSession(n)
	}
	for k, m := range maps {
		if got := size(m); got != start[k] {
			t.Errorf("%s: %d entries after the sessions ended, want %d", k, got, start[k])
		}
	}
}

// #7462: a session killed with a request open never sends the event that closes it, so its entry in openRequests is dropped when the session is forgotten. Nothing is left behind, and a session that
// starts again under the same id does not find a request that is not open: its first stop does not kick the feed.
func TestAKilledSessionsOpenRequestIsForgotten(t *testing.T) {
	h := &SessionsHandler{}
	sid := "bbbbbbbb-7462-4000-8000-000000000001"
	name := "codex-" + sid
	h.kickFeedForRequestChange(sid, "permission_request")
	if _, open := openRequests.Load(sid); !open {
		t.Fatal("the request is open")
	}
	ptymanager.ForgetSession(name) // the session is killed: no request_resolved or stop will ever come
	if _, open := openRequests.Load(sid); open {
		t.Fatal("a killed session's open request is still remembered")
	}
	gen := func() uint64 { h.wsList.mu.Lock(); defer h.wsList.mu.Unlock(); return uint64(h.wsList.kickGen) }
	before := gen()
	h.kickFeedForRequestChange(sid, "stop") // the session's first stop after it starts again
	if gen() != before {
		t.Fatal("a stop with no request open kicked the feed: the entry was not forgotten")
	}
	h.kickFeedForRequestChange(sid, "permission_request")
	h.kickFeedForRequestChange(sid, "request_resolved")
	if gen() != before+2 {
		t.Fatalf("a request opened and closed still kicks twice (%d -> %d)", before, gen())
	}
}
