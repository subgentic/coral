package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11979 (Security's SHOULD on #11946): agent_wait_ignored must not grow for ever. A row belongs to an agent that is live; when the Operator hides another request, the rows of agents that are no longer live
// (ended, stopped, replaced by a restart, deleted) are removed with it, and the rows of live agents, sleeping ones included, stay.
func TestHidingARequestRemovesTheRowsOfAgentsThatAreGone(t *testing.T) {
	s := NewSessionStore(openTestDB(t))
	ctx := context.Background()
	live := func(id string, sleeping bool) {
		t.Helper()
		require.NoError(t, s.RegisterLiveSession(ctx, &LiveSession{SessionID: id, AgentName: id, AgentType: "claude", WorkingDir: "/fixture", PID: 123}))
		if sleeping {
			_, err := s.db.ExecContext(ctx, `UPDATE live_sessions SET is_sleeping=1 WHERE session_id=?`, id)
			require.NoError(t, err)
		}
	}
	live("awake", false)
	live("asleep", true)
	live("stopped", false)
	_, err := s.db.ExecContext(ctx, `UPDATE live_sessions SET status='stopped' WHERE session_id='stopped'`)
	require.NoError(t, err)
	for _, id := range []string{"awake", "asleep", "stopped", "deleted-long-ago"} { // the last has no live_sessions row at all
		require.NoError(t, s.SetWaitIgnored(ctx, id, "k-"+id))
	}
	// each Set prunes the others: after the last one only live agents are left
	require.NoError(t, s.SetWaitIgnored(ctx, "awake", "k-awake-2"))
	keys, err := s.WaitIgnoredKeys(ctx)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"awake": "k-awake-2", "asleep": "k-asleep"}, keys, "a stopped agent's row and one with no live session are gone; a sleeping agent's stays")
}

// #14266: a removal needs the request to be ignored first, is kept for that request only, and a new request is neither ignored nor removed.
func TestAWaitIsRemovedOnlyAfterItWasIgnoredAndOnlyForThatRequest(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	ok, err := s.SetWaitRemoved(ctx, "sess-1", "req-a")
	require.NoError(t, err)
	assert.False(t, ok, "nothing was ignored: nothing to remove")

	require.NoError(t, s.SetWaitIgnored(ctx, "sess-1", "req-a"))
	removed, err := s.WaitRemovedKeys(ctx)
	require.NoError(t, err)
	assert.Empty(t, removed, "ignored is not removed")
	ok, err = s.SetWaitRemoved(ctx, "sess-1", "req-b")
	require.NoError(t, err)
	assert.False(t, ok, "another request than the ignored one cannot be removed")
	ok, err = s.SetWaitRemoved(ctx, "sess-1", "req-a")
	require.NoError(t, err)
	assert.True(t, ok)
	removed, _ = s.WaitRemovedKeys(ctx)
	assert.Equal(t, map[string]string{"sess-1": "req-a"}, removed)

	require.NoError(t, s.SetWaitIgnored(ctx, "sess-1", "req-a"))
	removed, _ = s.WaitRemovedKeys(ctx)
	assert.Equal(t, map[string]string{"sess-1": "req-a"}, removed, "an ignore of the same request keeps the removal")

	require.NoError(t, s.SetWaitIgnored(ctx, "sess-1", "req-c"))
	removed, _ = s.WaitRemovedKeys(ctx)
	assert.Empty(t, removed, "the next request is not removed")
	ignored, _ := s.WaitIgnoredKeys(ctx)
	assert.Equal(t, "req-c", ignored["sess-1"])
}
