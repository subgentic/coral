package board

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11432: the grant to a board's orchestrator and the log of what agents did to the board's agents.

func orchStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	return s
}

func TestABoardHasNoGrantUntilTheOperatorWritesOne(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	g, err := s.GetOrchGrant(ctx, "team")
	require.NoError(t, err)
	assert.False(t, g.Enabled, "off by default")
	assert.Empty(t, g.SeatSession)
	assert.Equal(t, DefaultOrchMaxPerHour, g.MaxPerHour)
	assert.Equal(t, DefaultOrchMaxLive, g.MaxLive)
	assert.Equal(t, DefaultOrchIdleMin, g.IdleMin)

	require.NoError(t, s.SetOrchGrant(ctx, OrchGrant{Project: "team", Enabled: true, SeatSession: " sess-1 ", MaxPerHour: 3, MaxLive: 4, IdleMin: 7}, "Operator"))
	g, err = s.GetOrchGrant(ctx, "team")
	require.NoError(t, err)
	assert.True(t, g.Enabled)
	assert.Equal(t, "sess-1", g.SeatSession)
	assert.Equal(t, 3, g.MaxPerHour)
	assert.Equal(t, "Operator", g.SetBy)
	other, _ := s.GetOrchGrant(ctx, "other")
	assert.False(t, other.Enabled, "another board is not touched")
}

func TestAGrantNeedsASeatAndSaneCaps(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	ok := OrchGrant{Project: "team", Enabled: true, SeatSession: "s", MaxPerHour: 5, MaxLive: 5, IdleMin: 5}
	for name, mod := range map[string]func(*OrchGrant){
		"on with no seat":      func(g *OrchGrant) { g.SeatSession = "" },
		"no hourly cap":        func(g *OrchGrant) { g.MaxPerHour = 0 },
		"hourly cap too big":   func(g *OrchGrant) { g.MaxPerHour = MaxOrchMaxPerHour + 1 },
		"no live cap":          func(g *OrchGrant) { g.MaxLive = 0 },
		"live cap too big":     func(g *OrchGrant) { g.MaxLive = MaxOrchMaxLive + 1 },
		"no idle minutes":      func(g *OrchGrant) { g.IdleMin = 0 },
		"idle minutes too big": func(g *OrchGrant) { g.IdleMin = MaxOrchIdleMin + 1 },
	} {
		g := ok
		mod(&g)
		err := s.SetOrchGrant(ctx, g, "Operator")
		assert.True(t, errors.Is(err, ErrOrchGrantInvalid), name)
	}
	off := ok
	off.Enabled, off.SeatSession = false, ""
	assert.NoError(t, s.SetOrchGrant(ctx, off, "Operator"), "turning it off needs no seat")
}

func TestTheCapsAreCheckedAndWrittenAsOneStatementSoARaceCannotPassThem(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	const cap = 3
	var wg sync.WaitGroup
	var mu sync.Mutex
	passed, hourRefused := 0, 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.ReserveLifecycle(ctx, "team", LifecycleWake, "Orchestrator", "Dev", &LifecycleCaps{MaxPerHour: cap, MaxLive: 100, Live: 0})
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				passed++
			case errors.Is(err, ErrLifecycleCapHour):
				hourRefused++
			default:
				t.Errorf("unexpected: %v", err)
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, cap, passed, "twenty parallel requests pass the cap of three exactly three times")
	assert.Equal(t, 20-cap, hourRefused)
	log, err := s.LifecycleLog(ctx, "team", 50)
	require.NoError(t, err)
	assert.Len(t, log, cap, "a refused request writes nothing")
}

func TestTheLiveCapCountsLiveAgentsAndRequestsStillInFlight(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	caps := &LifecycleCaps{MaxPerHour: 100, MaxLive: 3, Live: 2} // two live already
	id, err := s.ReserveLifecycle(ctx, "team", LifecycleLaunch, "Orchestrator", "QA", caps)
	require.NoError(t, err, "one more fits")
	_, err = s.ReserveLifecycle(ctx, "team", LifecycleWake, "Orchestrator", "Dev", caps)
	assert.True(t, errors.Is(err, ErrLifecycleCapLive), "the launch in flight counts: no more than three")
	require.NoError(t, s.FinishLifecycle(ctx, id, "failed", "launch failed"))
	_, err = s.ReserveLifecycle(ctx, "team", LifecycleWake, "Orchestrator", "Dev", caps)
	assert.NoError(t, err, "a failed launch frees the room")
	_, err = s.ReserveLifecycle(ctx, "team", LifecycleSleep, "Orchestrator", "Dev", nil)
	assert.NoError(t, err, "a sleep has no cap")
}

func TestTheLogSurvivesAReopenAndKeepsWhatItWasGiven(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	ctx := context.Background()
	id, err := s.ReserveLifecycle(ctx, "team", LifecycleLaunch, "Dev", "Helper", nil)
	require.NoError(t, err)
	require.NoError(t, s.FinishLifecycle(ctx, id, "ok", "started"))
	require.NoError(t, s.Close())
	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	defer s.Close()
	log, err := s.LifecycleLog(ctx, "team", 10)
	require.NoError(t, err)
	require.Len(t, log, 1)
	assert.Equal(t, LifecycleEntry{ID: id, Project: "team", Kind: "launch", Actor: "Dev", Target: "Helper", Status: "ok", Note: "started", At: log[0].At}, log[0])
	// a restart does not reset the hourly count: the cap reads the log
	for i := 0; i < 2; i++ {
		_, err := s.ReserveLifecycle(ctx, "team", LifecycleWake, "Orchestrator", "Dev", &LifecycleCaps{MaxPerHour: 3, MaxLive: 100})
		require.NoError(t, err, i)
	}
	_, err = s.ReserveLifecycle(ctx, "team", LifecycleWake, "Orchestrator", "Dev", &LifecycleCaps{MaxPerHour: 3, MaxLive: 100})
	assert.True(t, errors.Is(err, ErrLifecycleCapHour), "the launch before the reopen counts")
}
