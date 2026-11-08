package resourcequeue

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14222: every way a hold or a place ends leaves exactly ONE end event with its reason, and renewals are counted on the hold, not recorded one row each. One record showed 200 of 918 holds with no end (a hold given
// back through Leave told nobody) and 46,260 'renewed' rows in 31 hours.

func (s *sink) endsOf(agent string) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Event
	for _, e := range s.ev {
		if e.Agent == agent && (e.Why != "" || e.Kind == "released" || e.Kind == "expired" || e.Kind == "gone" || e.Kind == "kicked" || e.Kind == "cancelled") {
			out = append(out, e)
		}
	}
	return out
}

func TestEveryWayAHoldEndsLeavesOneEndEventWithItsReason(t *testing.T) {
	alive := map[string]bool{"gone": true}
	s := &sink{}
	q, c := fixture(t, Config{OnEvent: s.add, WaitStale: WaitStale, Alive: func(a string) bool { v, ok := alive[a]; return !ok || v }})
	require.NoError(t, q.Define(Resource{Key: "pool", Slots: 9}))
	claimP := func(a string) { _, err := q.Claim("pool", Claimant{Agent: a}); require.NoError(t, err) }

	claimP("released")
	require.NoError(t, q.Release("pool", "released"))
	claimP("idle")
	require.NoError(t, q.ReleaseWhy("pool", "idle", "idle"))
	claimP("call")
	require.NoError(t, q.LeaveWhy("pool", "call", 0, "call ended")) // what the hook does for a hand claim: it used to leave NO event
	claimP("left")
	require.NoError(t, q.Leave("pool", "left", 0))
	claimP("kicked")
	st, _ := q.Status("pool")
	var kickedID int64
	for _, h := range st.Holders {
		if h.Agent == "kicked" {
			kickedID = h.ID
		}
	}
	require.NotZero(t, kickedID)
	require.NoError(t, q.Cancel(kickedID))
	claimP("lease")
	claimP("gone")
	alive["gone"] = false
	c.add(DefaultLease + time.Minute)
	_, err := q.Reap()
	require.NoError(t, err)

	for who, want := range map[string]struct{ kind, why string }{
		"released": {"released", "released"}, "idle": {"released", "idle"}, "call": {"released", "call ended"}, "left": {"released", "left"},
		"kicked": {"kicked", "kicked"}, "lease": {"expired", "lease"}, "gone": {"gone", "gone"},
	} {
		ends := s.endsOf(who)
		require.Len(t, ends, 1, "%s: exactly one end event, got %v", who, ends)
		assert.Equal(t, want.kind, ends[0].Kind, who)
		assert.Equal(t, want.why, ends[0].Why, who)
	}
}

func TestAPlaceThatEndsWithoutAGrantLeavesAnEndEventToo(t *testing.T) {
	s := &sink{}
	q, c := fixture(t, Config{OnEvent: s.add})
	claim(t, q, "mac", "holder", 0)
	claim(t, q, "mac", "leaver", 0)
	claim(t, q, "mac", "away", 0)
	claim(t, q, "mac", "keeper", 0)
	require.NoError(t, q.Release("mac", "leaver"))
	require.NoError(t, q.Leave("mac", "away", 10*time.Minute))
	c.add(11 * time.Minute) // the kept place's grace ends: dropped, and said
	_, err := q.Reap()
	require.NoError(t, err)
	assert.Equal(t, "left", s.endsOf("leaver")[0].Why)
	require.Len(t, s.endsOf("away"), 1)
	assert.Equal(t, "cancelled", s.endsOf("away")[0].Kind)
	assert.Equal(t, "away", s.endsOf("away")[0].Why, "a kept place nobody came back to")
	// removing a resource ends what was on it
	require.NoError(t, q.Define(Resource{Key: "tmp", Slots: 1}))
	claimT := func(a string) { _, err := q.Claim("tmp", Claimant{Agent: a}); require.NoError(t, err) }
	claimT("t-holder")
	claimT("t-waiter")
	require.NoError(t, q.Remove("tmp"))
	assert.Equal(t, "resource removed", s.endsOf("t-holder")[0].Why)
	assert.Equal(t, "resource removed", s.endsOf("t-waiter")[0].Why)
}

func TestRenewalsAreCountedOnTheHoldAndNeverARowEach(t *testing.T) {
	s := &sink{}
	q, c := fixture(t, Config{OnEvent: s.add})
	claim(t, q, "mac", "a", 0)
	for i := 0; i < 50; i++ {
		c.add(time.Minute)
		_, err := q.Renew("mac", "a")
		require.NoError(t, err)
	}
	for _, k := range s.kinds() {
		assert.NotContains(t, k, "renewed", "no row per renewal")
	}
	require.NoError(t, q.Release("mac", "a"))
	ends := s.endsOf("a")
	require.Len(t, ends, 1)
	assert.Equal(t, 50, ends[0].Renews, "the hold's end says how many times its lease was renewed")
}
