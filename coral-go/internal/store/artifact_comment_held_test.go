package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16850 (follow-ups of #14860): a comment held for a busy agent survives a restart, and the ask's 24 h do not drop it silently.

func TestAHeldCommentSurvivesARestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "held.db")
	open := func() (*SessionStore, *DB) {
		db, err := OpenWithKey(ctx, path, "")
		require.NoError(t, err)
		return NewSessionStore(db), db
	}
	s, db := open()
	require.NoError(t, s.RegisterLiveSession(ctx, &LiveSession{SessionID: "sess-1", AgentType: "claude", AgentName: "dev", WorkingDir: "/tmp"}))
	now := time.Now()
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", now)
	require.NoError(t, err)
	ok, err := s.HoldAskMessage(ctx, 1, "sess-1", "the held words", false, false, now)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, db.Close()) // the server stops

	s, db = open() // and starts again
	defer db.Close()
	held, err := s.HeldAsks(ctx, 10)
	require.NoError(t, err)
	require.Len(t, held, 1, "the comment is still held after the restart")
	assert.Equal(t, "the held words", held[0].QueuedMsg)
}

func TestAHeldCommentIsNotDroppedWhenTheAsksDayPasses(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	require.NoError(t, s.RegisterLiveSession(ctx, &LiveSession{SessionID: "sess-1", AgentType: "claude", AgentName: "dev", WorkingDir: "/tmp"}))
	then := time.Now().Add(-AskTTL - time.Hour) // the agent was busy for more than a day
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-1", "Dev", then)
	require.NoError(t, err)
	ok, err := s.HoldAskMessage(ctx, 1, "sess-1", "the held words", false, false, then)
	require.NoError(t, err)
	require.True(t, ok)

	held, err := s.HeldAsks(ctx, 10)
	require.NoError(t, err)
	require.Len(t, held, 1, "a held comment waits for its agent however long it is busy")

	now := time.Now()
	n, err := s.ReleaseHeldAsks(ctx, []int64{held[0].ID}, now)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	a, found, err := s.GetArtifactAsk(ctx, 1, "sess-1")
	require.NoError(t, err)
	require.True(t, found)
	assert.True(t, a.OpenAt(now.Add(time.Hour)), "delivered, the ask is open again: the agent has its day to answer from now")
	assert.Nil(t, a.QueuedAt)
}
