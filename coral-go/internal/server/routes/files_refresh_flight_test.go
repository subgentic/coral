package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Security's SHOULD on #13079: a pass that panics must not leave its key stuck (every later refresh of the folder waited for a call that never finished).
func TestRefreshFlightFreesTheKeyWhenAPassPanics(t *testing.T) {
	f := &refreshFlight{calls: map[string]*refreshCall{}, recent: map[string]refreshRecent{}}
	func() {
		defer func() { _ = recover() }()
		_, _, _ = f.do(context.Background(), "k", false, func() refreshedFiles { panic("git went wrong") })
	}()
	done := make(chan refreshedFiles, 1)
	go func() {
		r, _, _ := f.do(context.Background(), "k", false, func() refreshedFiles { return refreshedFiles{total: 7} })
		done <- r
	}()
	select {
	case r := <-done:
		require.Equal(t, 7, r.total, "the next call runs its own pass")
	case <-time.After(3 * time.Second):
		t.Fatal("the next refresh of the folder waits for a pass that panicked")
	}
}

// Security's INFO b: a person's Refresh right after a slow pass is a new pass, not the answer the slow one left.
func TestRefreshFlightFreshAsksForANewPassButTheDefaultReusesASlowOne(t *testing.T) {
	f := &refreshFlight{calls: map[string]*refreshCall{}, recent: map[string]refreshRecent{}}
	runs := 0
	pass := func() refreshedFiles { runs++; time.Sleep(300 * time.Millisecond); return refreshedFiles{total: runs} }
	_, _, _ = f.do(context.Background(), "k", false, pass)
	r, _, _ := f.do(context.Background(), "k", false, pass)
	require.Equal(t, 1, runs, "the page's own ask just after a slow pass reuses it")
	require.Equal(t, 1, r.total)
	r, _, _ = f.do(context.Background(), "k", true, pass)
	require.Equal(t, 2, runs, "Refresh runs a new pass")
	require.Equal(t, 2, r.total)
}

// QA's SHOULD 6 on #13079: two agents in one folder, known by name with no session id, are not one pass.
func TestRefreshFlightKeyKeepsAgentsInOneFolderApart(t *testing.T) {
	a := refreshFlightKey("/work/repo", "branch_point", "", false, "agent-a")
	b := refreshFlightKey("/work/repo", "branch_point", "", false, "agent-b")
	require.NotEqual(t, a, b, "two agents of one folder with no session id do not share a pass")
	require.Equal(t, a, refreshFlightKey("/work/repo", "branch_point", "", false, "agent-a"), "the same agent asking again does")
	require.NotEqual(t, a, refreshFlightKey("/work/repo", "branch_point", "", true, "agent-a"), "a followed worktree is its own pass")
	require.NotEqual(t, a, refreshFlightKey("/work/repo", "main_head", "", false, "agent-a"), "and so is another mode")
}
