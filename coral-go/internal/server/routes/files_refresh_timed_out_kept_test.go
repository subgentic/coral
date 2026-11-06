package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #13753 (QA's SHOULD on #304): a pass that ran out of time is never itself the last list kept for its key. It answers the kept list; if it were kept it would stamp that list as fresh again on
// every timeout (so it never ages out), and, with no earlier list, would keep the launch folder's stored list in place of a newer one the poller writes.
func TestATimedOutPassIsNeverKeptAsTheLastList(t *testing.T) {
	f := &refreshFlight{calls: map[string]*refreshCall{}, recent: map[string]refreshRecent{}, last: map[string]refreshKept{}}
	ctx := context.Background()
	good := refreshedFiles{files: []store.ChangedFile{{Filepath: "a.txt"}}, total: 1}
	timedOut := refreshedFiles{files: []store.ChangedFile{{Filepath: "stored.txt"}, {Filepath: "stored2.txt"}}, total: 2, timedOut: true}

	// a finished pass is kept; a timed out one after it leaves that one as the kept list
	_, _, ok := f.do(ctx, "k", true, func() refreshedFiles { return good })
	require.True(t, ok)
	_, _, ok = f.do(ctx, "k", true, func() refreshedFiles { return timedOut })
	require.True(t, ok)
	last, found := f.lastFor("k")
	require.True(t, found)
	require.False(t, last.timedOut, "the kept list is the finished pass's")
	require.Equal(t, 1, last.total)

	// with no finished pass before, a timed out one keeps nothing
	_, _, ok = f.do(ctx, "other", true, func() refreshedFiles { return timedOut })
	require.True(t, ok)
	_, found = f.lastFor("other")
	require.False(t, found, "a timed out pass is not a last list")
}
