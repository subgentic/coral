package store_test

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// Test runs are claimed in one transaction with their count, so calls at the same moment cannot pass the hourly limit together; a run that did not start gives its slot back.
func TestTeamTestRunSlotsAreTakenAtomically(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ws := store.NewWorkflowStore(db)

	const limit = 3
	var wg sync.WaitGroup
	var mu sync.Mutex
	var got, refused int
	var ids []int64
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := ws.ClaimTeamTestRun(ctx, "t", 1, "n", "hash", "Orchestrator", limit)
			mu.Lock()
			defer mu.Unlock()
			switch err {
			case nil:
				got++
				ids = append(ids, id)
			case store.ErrTeamTestRunLimit:
				refused++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, limit, got, "exactly the limit of calls took a slot")
	assert.Equal(t, 12-limit, refused)

	ws.ReleaseTeamTestRun(ctx, ids[0])
	_, err = ws.ClaimTeamTestRun(ctx, "t", 1, "n", "hash", "Orchestrator", limit)
	assert.NoError(t, err, "a slot given back can be taken again")
	_, err = ws.ClaimTeamTestRun(ctx, "t", 1, "n", "hash", "Orchestrator", limit)
	assert.ErrorIs(t, err, store.ErrTeamTestRunLimit)
	_, err = ws.ClaimTeamTestRun(ctx, "other", 1, "n", "hash", "Orchestrator", limit)
	assert.NoError(t, err, "another team has its own count")
}
