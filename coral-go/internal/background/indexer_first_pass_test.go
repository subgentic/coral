package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #10291 (Desktop pass 25): during the first index pass All chats said "No chats here" over a history that had not been read yet. The indexer says when its first pass after start has finished.
func TestTheIndexerSaysWhenItsFirstPassIsDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	db, err := store.OpenWithKey(ctx, filepath.Join(t.TempDir(), "sessions.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	idx := NewSessionIndexer(store.NewSessionStore(db), nil, time.Hour, 300*time.Millisecond)
	assert.False(t, idx.FirstPassDone(), "before it has run")
	done := make(chan struct{})
	go func() { _ = idx.Run(ctx); close(done) }()
	time.Sleep(100 * time.Millisecond) // sleep-ok: still inside the startup delay: the negative needs a wait
	assert.False(t, idx.FirstPassDone(), "not while it waits for its startup delay")
	require.Eventually(t, idx.FirstPassDone, 5*time.Second, 20*time.Millisecond, "after the first pass")
	cancel()
	<-done
}
