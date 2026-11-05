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
		"with a match":     {Key: "p6", Members: []string{"mini"}, Match: []string{"go test ./..."}},
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
