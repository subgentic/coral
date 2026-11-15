package resourcequeue

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17586: a pool spreads work by recent use and only to a member whose facts meet the command's needs.

func spreadQueue(t *testing.T, cfg Config) (*Queue, *clock) {
	t.Helper()
	c := &clock{t: time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)}
	cfg.Now = c.now
	q, err := New(cfg)
	require.NoError(t, err)
	for _, r := range []Resource{
		{Key: "mac", Slots: 2, Weight: 8, Facts: map[string]string{"os": "darwin", "go": "1.26"}},
		{Key: "mini", Slots: 1, Weight: 8, Facts: map[string]string{"os": "darwin", "go": "1.26"}},
		{Key: "epoch", Slots: 2, Weight: 16, Facts: map[string]string{"os": "linux", "go": "1.26"}},
		{Key: "frontier", Slots: 4, Weight: 48, Facts: map[string]string{"os": "windows", "go": "1.25"}},
	} {
		require.NoError(t, q.Define(r))
	}
	require.NoError(t, q.Define(Resource{Key: "any", Members: []string{"mac", "mini", "epoch", "frontier"}}))
	require.NoError(t, q.Define(Resource{Key: "linux", Members: []string{"mac", "mini", "epoch", "frontier"}, Needs: []string{"os=linux"}}))
	return q, c
}

func TestARunSpreadsOverEveryBoxByWeightNotListedOrder(t *testing.T) {
	q, c := spreadQueue(t, Config{})
	got := map[string]int{}
	for i := 0; i < 40; i++ { // 40 two-minute runs, one at a time, as agents come and go
		r, err := q.Claim("any", Claimant{Agent: fmt.Sprintf("a%d", i)})
		require.NoError(t, err)
		require.True(t, r.Granted)
		got[r.Entry.Member]++
		c.t = c.t.Add(2 * time.Minute)
		require.NoError(t, q.Release("any", fmt.Sprintf("a%d", i)))
	}
	assert.Len(t, got, 4, "every box was used: %v", got)
	// The heaviest box takes the most, the lightest the least.
	assert.Greater(t, got["frontier"], got["epoch"], "%v", got)
	assert.Greater(t, got["epoch"], got["mac"], "%v", got)
}

func TestARunWithNeedsOnlyLandsOnABoxThatMeetsThem(t *testing.T) {
	q, _ := spreadQueue(t, Config{})
	for i := 0; i < 4; i++ {
		r, err := q.Claim("linux", Claimant{Agent: fmt.Sprintf("l%d", i), Needs: []string{"os=linux"}})
		require.NoError(t, err)
		if i < 2 {
			require.True(t, r.Granted)
			assert.Equal(t, "epoch", r.Entry.Member, "only epoch is Linux")
		} else {
			assert.False(t, r.Granted, "epoch's two slots are full: it waits, never on the Mac or frontier")
		}
	}
	_, err := q.Claim("linux", Claimant{Agent: "x", Needs: []string{"os=freebsd"}})
	assert.ErrorIs(t, err, ErrNoCapable, "no box could ever run it: refused with the reason, not queued for ever")
	r, err := q.Claim("any", Claimant{Agent: "g", Needs: []string{"go>=1.26", "os!=windows"}})
	require.NoError(t, err)
	assert.Contains(t, []string{"mac", "mini"}, r.Entry.Member, "epoch is full; frontier fails go>=1.26 and os!=windows")
}

func TestAClosedMemberTakesNoNewRunThroughThePool(t *testing.T) {
	closed := map[string]bool{"epoch": true, "frontier": true, "mac": true}
	q, _ := spreadQueue(t, Config{Veto: func(m Resource) bool { return closed[m.Key] }})
	r, err := q.Claim("any", Claimant{Agent: "a"})
	require.NoError(t, err)
	assert.Equal(t, "mini", r.Entry.Member)
	b, err := q.Claim("any", Claimant{Agent: "b"})
	require.NoError(t, err)
	assert.False(t, b.Granted, "the mini is full and the rest are closed")
	own, err := q.Claim("epoch", Claimant{Agent: "own"})
	require.NoError(t, err)
	assert.True(t, own.Granted, "a claim by the box's own name is the agent's choice, never vetoed")
}

func TestFactsAndNeedsAreChecked(t *testing.T) {
	q, _ := spreadQueue(t, Config{})
	assert.ErrorIs(t, q.Define(Resource{Key: "z", Slots: 1, Facts: map[string]string{"bad key": "x"}}), ErrBadFacts)
	assert.ErrorIs(t, q.Define(Resource{Key: "z", Slots: 1, Weight: -1}), ErrBadWeight)
	assert.ErrorIs(t, q.Define(Resource{Key: "z", Members: []string{"mac"}, Needs: []string{"go>=abc"}}), ErrBadNeeds)
	assert.ErrorIs(t, q.Define(Resource{Key: "z", Members: []string{"mac"}, Needs: []string{"nonsense"}}), ErrBadNeeds)
	assert.True(t, Meets(map[string]string{"cores": "16"}, []string{"cores>=8"}))
	assert.False(t, Meets(map[string]string{}, []string{"cores>=8"}), "a missing fact is not met")
	assert.True(t, Meets(map[string]string{}, []string{"os!=windows"}), "!= asks only that it is not that value")
}
