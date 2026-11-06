package resourcequeue

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13719 step 1: a pool is a resource made of other resources ("heavy" = the Mac's slots and the mini's). A claim on it is granted the first free slot of any member, in member order, and waits in ONE line when none is
// free; the entry says which member it holds. A pool changes nothing for the members' own claims.

func poolFixture(t *testing.T, cfg Config) (*Queue, *clock) {
	t.Helper()
	c := &clock{t: time.Date(2026, 11, 5, 22, 0, 0, 0, time.UTC)}
	cfg.Now = c.now
	q, err := New(cfg)
	require.NoError(t, err)
	require.NoError(t, q.Define(Resource{Key: "mac-heavy", Slots: 2, Machine: "mac"}))
	require.NoError(t, q.Define(Resource{Key: "mini", Slots: 1, Machine: "mini", MaxLease: 10 * time.Minute}))
	require.NoError(t, q.Define(Resource{Key: "heavy", Members: []string{"mac-heavy", "mini"}}))
	return q, c
}

func poolClaim(t *testing.T, q *Queue, key, agent string, prio int) Result {
	t.Helper()
	r, err := q.Claim(key, Claimant{Agent: agent, Priority: prio})
	require.NoError(t, err)
	return r
}

func TestAPoolGrantsTheFirstFreeSlotOfAnyMemberInMemberOrderAndWaitsInOneLine(t *testing.T) {
	q, _ := poolFixture(t, Config{})
	a := poolClaim(t, q, "heavy", "a", 0)
	b := poolClaim(t, q, "heavy", "b", 0)
	cc := poolClaim(t, q, "heavy", "c", 0)
	d := poolClaim(t, q, "heavy", "d", 0)
	assert.True(t, a.Granted)
	assert.Equal(t, "mac-heavy", a.Entry.Member)
	assert.Equal(t, "mac-heavy", b.Entry.Member, "the Mac has two slots")
	assert.Equal(t, "mini", cc.Entry.Member, "then the next member")
	assert.False(t, d.Granted)
	assert.Equal(t, 1, d.Place, "nothing free: one line for the pool")
	e := poolClaim(t, q, "heavy", "e", 0)
	assert.Equal(t, 2, e.Place)
	require.NoError(t, q.Release("heavy", "c")) // the mini's slot frees: the next in the pool's line gets THAT member
	st, err := q.Status("heavy")
	require.NoError(t, err)
	var got []string
	for _, h := range st.Holders {
		got = append(got, h.Agent+"@"+h.Member)
	}
	assert.ElementsMatch(t, []string{"a@mac-heavy", "b@mac-heavy", "d@mini"}, got)
	require.Len(t, st.Queue, 1)
	assert.Equal(t, "e", st.Queue[0].Agent)
}

func TestAPoolAndItsMembersShareTheSlots(t *testing.T) {
	q, _ := poolFixture(t, Config{})
	poolClaim(t, q, "mac-heavy", "hand1", 0) // a hand claim on the Mac
	poolClaim(t, q, "mac-heavy", "hand2", 0)
	p := poolClaim(t, q, "heavy", "p1", 0)
	assert.Equal(t, "mini", p.Entry.Member, "the Mac is full from direct claims: the pool uses the mini")
	p2 := poolClaim(t, q, "heavy", "p2", 0)
	assert.False(t, p2.Granted)
	require.NoError(t, q.Release("mac-heavy", "hand1")) // a Mac slot frees: the pool's waiting entry gets it
	st, _ := q.Status("heavy")
	var holders []string
	for _, h := range st.Holders {
		holders = append(holders, h.Agent+"@"+h.Member)
	}
	assert.ElementsMatch(t, []string{"p1@mini", "p2@mac-heavy"}, holders)
	// and the member's own view counts the pool's holds on it
	ms, _ := q.Status("mac-heavy")
	assert.Len(t, ms.Holders, 2, "hand2 and the pool's p2 hold the Mac")
	// a pool hold frees a slot for a member's own waiting claim
	h3 := poolClaim(t, q, "mac-heavy", "hand3", 0)
	assert.False(t, h3.Granted)
	require.NoError(t, q.Release("heavy", "p2"))
	ms, _ = q.Status("mac-heavy")
	assert.Len(t, ms.Holders, 2)
	assert.Equal(t, 0, len(ms.Queue), "hand3 got the slot the pool's p2 gave back")
}

func TestAPoolLineIsRankedLikeAnyOtherAndTheMembersLeaseApplies(t *testing.T) {
	q, c := poolFixture(t, Config{AgeStep: -1})
	for _, a := range []string{"a", "b", "c"} {
		poolClaim(t, q, "heavy", a, 0)
	}
	poolClaim(t, q, "heavy", "lo", 0)
	poolClaim(t, q, "heavy", "hi", 30)
	st, _ := q.Status("heavy")
	require.Len(t, st.Queue, 2)
	assert.Equal(t, []string{"hi", "lo"}, []string{st.Queue[0].Agent, st.Queue[1].Agent}, "a higher priority goes first in the pool's line")
	var mini Entry
	for _, h := range st.Holders {
		if h.Member == "mini" {
			mini = h
		}
	}
	assert.Equal(t, 10*time.Minute, mini.Lease.Sub(mini.Granted), "a hold on the mini lasts the mini's lease, not the pool's")
	c.add(11 * time.Minute)
	_, err := q.Reap()
	require.NoError(t, err)
	st, _ = q.Status("heavy")
	var who []string
	for _, h := range st.Holders {
		who = append(who, h.Agent)
	}
	assert.Contains(t, who, "hi", "the mini's hold expired: the first in the pool's line took it")
}

func TestPoolsAreRefusedWhenMalformed(t *testing.T) {
	q, _ := poolFixture(t, Config{})
	for name, r := range map[string]Resource{
		"unknown member":   {Key: "p1", Members: []string{"mac-heavy", "nowhere"}},
		"itself":           {Key: "p2", Members: []string{"p2"}},
		"a pool member":    {Key: "p3", Members: []string{"heavy"}},
		"duplicate":        {Key: "p4", Members: []string{"mini", "mini"}},
		"too many":         {Key: "p5", Members: []string{"mini", "mini", "mini", "mini", "mini", "mini", "mini", "mini", "mini"}},
		"a member's slots": {Key: "p7", Members: []string{"mini"}, Slots: 3},
	} {
		assert.ErrorIs(t, q.Define(r), ErrBadResource, name)
	}
	assert.ErrorIs(t, q.Define(Resource{Key: "mini", Members: []string{"mac-heavy"}}), ErrBadResource, "a member of a pool cannot become a pool")
	assert.ErrorIs(t, q.Remove("mini"), ErrInPool, "a resource in a pool is not removed from under it")
	require.NoError(t, q.Remove("heavy"))
	require.NoError(t, q.Remove("mini"), "once the pool is gone it can be")
}

func TestAPoolShowsTheSumOfItsMembersSlotsAndSurvivesARestart(t *testing.T) {
	p := &memPersist{}
	q, _ := poolFixture(t, Config{Persist: p})
	poolClaim(t, q, "heavy", "a", 0)
	st, _ := q.Status("heavy")
	assert.Equal(t, 3, st.Resource.Slots, "the pool reads as the sum of its members' slots")
	assert.Equal(t, []string{"mac-heavy", "mini"}, st.Resource.Members)
	q2, err := New(Config{Persist: p, Now: func() time.Time { return time.Date(2026, 11, 5, 22, 1, 0, 0, time.UTC) }})
	require.NoError(t, err)
	st2, err := q2.Status("heavy")
	require.NoError(t, err)
	require.Len(t, st2.Holders, 1)
	assert.Equal(t, "mac-heavy", st2.Holders[0].Member, "the member a hold is on is kept across a restart")
}

// QA Reviewer 2's SHOULDs on step 1.

// One merged ranking across the lines that share a slot: whatever freed it, the slot goes to the best waiter of ALL of them (priority, then age).
func TestAFreedSlotGoesToTheBestWaiterAcrossTheLinesThatShareIt(t *testing.T) {
	q, c := poolFixture(t, Config{AgeStep: -1})
	poolClaim(t, q, "mac-heavy", "m1", 0)
	poolClaim(t, q, "mac-heavy", "m2", 0)
	poolClaim(t, q, "mini", "x", 0)
	poolClaim(t, q, "mini", "lo", 0) // a direct waiter of low priority, first in time
	c.add(time.Minute)
	poolClaim(t, q, "heavy", "crit", 30) // a critical waiter of the pool
	require.NoError(t, q.Release("mini", "x"))
	st, _ := q.Status("mini")
	require.Len(t, st.Holders, 1)
	assert.Equal(t, "crit", st.Holders[0].Agent, "a critical pool waiter beats a low direct one for the mini's slot")
	assert.Equal(t, "mini", st.Holders[0].Member)

	// and the other way round: a critical direct waiter beats a low pool waiter
	q2, c2 := poolFixture(t, Config{AgeStep: -1})
	poolClaim(t, q2, "mac-heavy", "m1", 0)
	poolClaim(t, q2, "mac-heavy", "m2", 0)
	poolClaim(t, q2, "mini", "x", 0)
	poolClaim(t, q2, "heavy", "poollo", 0)
	c2.add(time.Minute)
	poolClaim(t, q2, "mini", "directhi", 30)
	require.NoError(t, q2.Release("mini", "x"))
	st, _ = q2.Status("mini")
	require.Len(t, st.Holders, 1)
	assert.Equal(t, "directhi", st.Holders[0].Agent, "and a critical direct waiter beats a low pool one")
}

func TestAPoolHoldOnTheMiniRenewsForTheMinisShorterLease(t *testing.T) {
	q, c := poolFixture(t, Config{})
	poolClaim(t, q, "heavy", "a", 0)
	poolClaim(t, q, "heavy", "b", 0)
	cc := poolClaim(t, q, "heavy", "c", 0)
	require.Equal(t, "mini", cc.Entry.Member)
	c.add(7 * time.Minute)
	e, err := q.Renew("heavy", "c")
	require.NoError(t, err)
	assert.Equal(t, 10*time.Minute, e.Lease.Sub(c.now()), "a renewal on the mini is the mini's ten minutes, not the pool's default")
}

func TestAPoolOfMoreThanMaxMembersIsRefusedAndMaxIsAllowed(t *testing.T) {
	q, _ := poolFixture(t, Config{})
	var names []string
	for i := 0; i < MaxMembers+1; i++ {
		n := string(rune('a'+i)) + "-res"
		require.NoError(t, q.Define(Resource{Key: n, Slots: 1}))
		names = append(names, n)
	}
	assert.ErrorIs(t, q.Define(Resource{Key: "big", Members: names}), ErrBadResource, "nine distinct members: over the cap")
	assert.NoError(t, q.Define(Resource{Key: "ok8", Members: names[:MaxMembers]}), "eight is allowed")
}

// An agent holds at most one slot across a pool and its members: a second claim joins its existing entry (a chained run is one command; it never needs two).
func TestAnAgentHoldsAtMostOneSlotAcrossAPoolAndItsMembers(t *testing.T) {
	q, _ := poolFixture(t, Config{})
	first := poolClaim(t, q, "heavy", "a", 0)
	require.True(t, first.Granted)
	again := poolClaim(t, q, "mac-heavy", "a", 0) // by the member's own name
	assert.Equal(t, first.Entry.ID, again.Entry.ID, "the same entry, not a second hold")
	again = poolClaim(t, q, "heavy", "a", 0)
	assert.Equal(t, first.Entry.ID, again.Entry.ID)
	assert.Equal(t, 1, q.held("mac-heavy"), "one slot used")
	// the other way: a direct hold, then a claim on the pool
	d := poolClaim(t, q, "mini", "b", 0)
	dp := poolClaim(t, q, "heavy", "b", 0)
	assert.Equal(t, d.Entry.ID, dp.Entry.ID, "a hold on the member is the agent's one slot")
	assert.Equal(t, 1, q.held("mini"))
	// and it is given back through either name
	require.NoError(t, q.Release("heavy", "b"))
	assert.Equal(t, 0, q.held("mini"), "released through the pool's name, held through the member's")
	require.NoError(t, q.Release("mac-heavy", "a"))
	assert.Equal(t, 0, q.held("mac-heavy"), "and the other way")
}

// #13751: a pool may carry a Match, and the hook then claims the pool.
func TestAPoolMayCarryAMatchAndAnyMatchSeesIt(t *testing.T) {
	q, _ := poolFixture(t, Config{})
	require.NoError(t, q.Define(Resource{Key: "movable", Members: []string{"mac-heavy", "mini"}, Match: []string{"go test ./..."}}))
	st, err := q.Status("movable")
	require.NoError(t, err)
	assert.Equal(t, []string{"go test ./..."}, st.Resource.Match)
	assert.True(t, q.AnyMatch())
}
