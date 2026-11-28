package resourcequeue

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #22131: a refused renew can say why and when the hold ended; and a hold carries a live run only while its process is alive.
func TestTheLastEndOfAHoldIsKeptAndALiveRunIsKnown(t *testing.T) {
	now := time.Date(2026, 11, 28, 4, 0, 0, 0, time.UTC)
	alive := map[int]bool{77: true}
	q, err := New(Config{Now: func() time.Time { return now }, PidAlive: func(pid int) bool { return alive[pid] }})
	require.NoError(t, err)
	require.NoError(t, q.Define(Resource{Key: "epoch-go", Slots: 1, MaxLease: 30 * time.Minute}))

	_, ok := q.LastEnd("epoch-go", "DevOps")
	assert.False(t, ok, "no end yet")
	_, err = q.Claim("epoch-go", Claimant{Agent: "DevOps", RunID: "r1", RunPID: 77})
	require.NoError(t, err)
	assert.True(t, q.HasLiveRun("epoch-go", "DevOps"))
	assert.False(t, q.HasLiveRun("epoch-go", "QA"), "another agent holds nothing")
	alive[77] = false
	assert.False(t, q.HasLiveRun("epoch-go", "DevOps"), "a run whose process is gone is not live")
	alive[77] = true

	now = now.Add(31 * time.Minute) // never renewed: the lease ends it
	_, err = q.Reap()
	require.NoError(t, err)
	end, ok := q.LastEnd("epoch-go", "DevOps")
	require.True(t, ok)
	assert.Equal(t, HoldEnd{Kind: "expired", Why: "lease", At: now}, end)
	_, err = q.Renew("epoch-go", "DevOps")
	assert.ErrorIs(t, err, ErrNotHolder)

	_, err = q.Claim("epoch-go", Claimant{Agent: "QA"})
	require.NoError(t, err)
	_, err = q.Claim("epoch-go", Claimant{Agent: "Other"}) // waits: a place in line is not a hold, and its end is not kept
	require.NoError(t, err)
	require.NoError(t, q.Release("epoch-go", "Other"))
	_, ok = q.LastEnd("epoch-go", "Other")
	assert.False(t, ok, "a waiting place that left was never a hold")
}
