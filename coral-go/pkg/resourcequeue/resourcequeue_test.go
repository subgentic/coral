package resourcequeue

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func fixture(t *testing.T, cfg Config) (*Queue, *clock) {
	t.Helper()
	c := &clock{t: time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)}
	cfg.Now = c.now
	q, err := New(cfg)
	require.NoError(t, err)
	require.NoError(t, q.Define(Resource{Key: "mac", Slots: 1}))
	return q, c
}

func claim(t *testing.T, q *Queue, key, agent string, prio int) Result {
	t.Helper()
	r, err := q.Claim(key, Claimant{Agent: agent, Priority: prio})
	require.NoError(t, err)
	return r
}

func names(es []Entry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.Agent)
	}
	return out
}

func TestOneSlotOneHolderTheRestWaitInOrder(t *testing.T) {
	var granted []string
	q, _ := fixture(t, Config{OnGrant: func(e Entry) { granted = append(granted, e.Agent) }})
	a, b, c := claim(t, q, "mac", "a", 0), claim(t, q, "mac", "b", 0), claim(t, q, "mac", "c", 0)
	assert.True(t, a.Granted)
	assert.False(t, b.Granted)
	assert.Equal(t, 1, b.Place)
	assert.Equal(t, 2, c.Place)
	require.NoError(t, q.Release("mac", "a"))
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"b"}, names(st.Holders), "the next in line holds it now")
	assert.Equal(t, []string{"c"}, names(st.Queue))
	assert.Equal(t, []string{"b"}, granted, "and was told")
	require.NoError(t, q.Release("mac", "c"), "a waiting agent can leave the line")
	st, _ = q.Status("mac")
	assert.Empty(t, st.Queue)
}

func TestSeveralSlotsAreHeldAtOnceAndNeverMoreThanTheSlots(t *testing.T) {
	q, _ := fixture(t, Config{})
	require.NoError(t, q.Define(Resource{Key: "mini", Slots: 2}))
	assert.True(t, claim(t, q, "mini", "a", 0).Granted)
	assert.True(t, claim(t, q, "mini", "b", 0).Granted)
	assert.False(t, claim(t, q, "mini", "c", 0).Granted)
	st, _ := q.Status("mini")
	assert.Len(t, st.Holders, 2)
	// more slots grant the waiting at once; fewer never take a slot from a holder
	require.NoError(t, q.Define(Resource{Key: "mini", Slots: 3}))
	st, _ = q.Status("mini")
	assert.Len(t, st.Holders, 3)
	require.NoError(t, q.Define(Resource{Key: "mini", Slots: 1}))
	st, _ = q.Status("mini")
	assert.Len(t, st.Holders, 3, "the holds run out; nobody is evicted")
	claim(t, q, "mini", "d", 0)
	require.NoError(t, q.Release("mini", "a"))
	st, _ = q.Status("mini")
	assert.Len(t, st.Holders, 2, "no new grant while the holders are over the new slot count")
	assert.Equal(t, []string{"d"}, names(st.Queue))
}

func TestAskingAgainIsTheSameAsk(t *testing.T) {
	q, _ := fixture(t, Config{})
	claim(t, q, "mac", "a", 0)
	first := claim(t, q, "mac", "b", 1)
	again := claim(t, q, "mac", "b", 5)
	assert.Equal(t, first.Entry.ID, again.Entry.ID)
	assert.Equal(t, 5, again.Entry.Priority, "a higher priority is taken")
	assert.Equal(t, 5, claim(t, q, "mac", "b", 2).Entry.Priority, "a lower one is not")
	st, _ := q.Status("mac")
	assert.Len(t, st.Queue, 1)
}

func TestTheLineIsByPriorityThenFirstComeFirstServed(t *testing.T) {
	q, c := fixture(t, Config{AgeStep: -1})
	claim(t, q, "mac", "holder", 0)
	claim(t, q, "mac", "low1", 1)
	c.add(time.Second)
	claim(t, q, "mac", "high", 9)
	c.add(time.Second)
	claim(t, q, "mac", "low2", 1)
	c.add(time.Second)
	claim(t, q, "mac", "mid", 5)
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"high", "mid", "low1", "low2"}, names(st.Queue))
}

func TestWaitingSlowlyRaisesRankSoNobodyStarves(t *testing.T) {
	q, c := fixture(t, Config{AgeStep: 10 * time.Minute, AgeCap: 5})
	claim(t, q, "mac", "holder", 0)
	claim(t, q, "mac", "patient", 0)
	c.add(2 * time.Hour) // 12 steps, capped at 5
	claim(t, q, "mac", "newcomer", 3)
	claim(t, q, "mac", "urgent", 9)
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"urgent", "patient", "newcomer"}, names(st.Queue), "5 points of waiting beat a newcomer at 3, but not an urgent 9")
}

func TestALeaseThatRunsOutFreesTheSlotAndRenewingKeepsIt(t *testing.T) {
	var granted []string
	q, c := fixture(t, Config{OnGrant: func(e Entry) { granted = append(granted, e.Agent) }})
	require.NoError(t, q.Define(Resource{Key: "mac", Slots: 1, MaxLease: 10 * time.Minute}))
	claim(t, q, "mac", "a", 0)
	claim(t, q, "mac", "b", 0)
	c.add(9 * time.Minute)
	ended, err := q.Reap()
	require.NoError(t, err)
	assert.Empty(t, ended, "not yet")
	_, err = q.Renew("mac", "a")
	require.NoError(t, err)
	c.add(9 * time.Minute)
	ended, _ = q.Reap()
	assert.Empty(t, ended, "renewed: a full lease from the renewal")
	c.add(2 * time.Minute)
	ended, _ = q.Reap()
	require.Len(t, ended, 1)
	assert.Equal(t, "a", ended[0].Agent)
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"b"}, names(st.Holders))
	assert.Equal(t, []string{"b"}, granted)
	_, err = q.Renew("mac", "a")
	assert.ErrorIs(t, err, ErrNotHolder)
	_, err = q.Renew("mac", "b-waiting")
	assert.ErrorIs(t, err, ErrNotHolder)
}

func TestAnAgentThatIsGoneLosesItsHoldAndItsPlace(t *testing.T) {
	alive := map[string]bool{"a": true, "b": true, "c": true}
	q, _ := fixture(t, Config{Alive: func(a string) bool { return alive[a] }})
	claim(t, q, "mac", "a", 0)
	claim(t, q, "mac", "b", 0)
	claim(t, q, "mac", "c", 0)
	alive["a"], alive["b"] = false, false
	ended, err := q.Reap()
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"a", "b"}, names(ended))
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"c"}, names(st.Holders), "the one still alive is next")
}

func TestAPersonsMoveSetsTheLineAndNewcomersJoinBehind(t *testing.T) {
	q, c := fixture(t, Config{AgeStep: -1})
	claim(t, q, "mac", "holder", 0)
	var ids = map[string]int64{}
	for _, n := range []string{"a", "b", "c", "d"} {
		ids[n] = claim(t, q, "mac", n, 0).Entry.ID
		c.add(time.Second)
	}
	require.NoError(t, q.Move(ids["d"], "first"))
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"d", "a", "b", "c"}, names(st.Queue))
	require.NoError(t, q.Move(ids["c"], "up"))
	st, _ = q.Status("mac")
	assert.Equal(t, []string{"d", "a", "c", "b"}, names(st.Queue))
	require.NoError(t, q.Move(ids["d"], "down"))
	st, _ = q.Status("mac")
	assert.Equal(t, []string{"a", "d", "c", "b"}, names(st.Queue))
	claim(t, q, "mac", "late-urgent", 9)
	st, _ = q.Status("mac")
	assert.Equal(t, []string{"a", "d", "c", "b", "late-urgent"}, names(st.Queue), "the person's order stands; a newcomer joins behind it")
	assert.Error(t, q.Move(ids["a"], "sideways"))
	assert.ErrorIs(t, q.Move(9999, "up"), ErrNoEntry)
	assert.ErrorIs(t, q.Move(1, "up"), ErrNoEntry, "a holder is not in line")
	require.NoError(t, q.Move(ids["a"], "up"), "up from the front stays at the front")
}

func TestKickingAHolderGrantsTheNext(t *testing.T) {
	q, _ := fixture(t, Config{})
	h := claim(t, q, "mac", "a", 0)
	claim(t, q, "mac", "b", 0)
	require.NoError(t, q.Cancel(h.Entry.ID))
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"b"}, names(st.Holders))
	assert.ErrorIs(t, q.Cancel(h.Entry.ID), ErrNoEntry)
}

func TestWhoMayClaimAndHowManyMayWait(t *testing.T) {
	q, _ := fixture(t, Config{MaxPerAgent: 2})
	require.NoError(t, q.Define(Resource{Key: "secret", Slots: 1, Allowed: []string{"ok"}}))
	_, err := q.Claim("secret", Claimant{Agent: "nope"})
	assert.ErrorIs(t, err, ErrNotAllowed)
	_, err = q.Claim("missing", Claimant{Agent: "a"})
	assert.ErrorIs(t, err, ErrNoResource)
	assert.ErrorIs(t, q.Release("missing", "a"), ErrNoResource)
	assert.ErrorIs(t, q.Release("mac", "nobody"), ErrNotHolder)
	require.NoError(t, q.Define(Resource{Key: "r2", Slots: 1}))
	require.NoError(t, q.Define(Resource{Key: "r3", Slots: 1}))
	for _, k := range []string{"mac", "r2", "r3"} {
		claim(t, q, k, "holder", 0)
	}
	claim(t, q, "mac", "greedy", 0)
	claim(t, q, "r2", "greedy", 0)
	_, err = q.Claim("r3", Claimant{Agent: "greedy"})
	assert.ErrorIs(t, err, ErrQueueFull, "an agent cannot fill the lines: two waiting at most, over all resources")
	assert.ErrorIs(t, q.Define(Resource{Key: "", Slots: 1}), ErrBadResource)
	assert.ErrorIs(t, q.Define(Resource{Key: "x", Slots: 0}), ErrBadResource)
	require.NoError(t, q.Remove("r3"))
	assert.ErrorIs(t, q.Remove("r3"), ErrNoResource)
}

type memPersist struct{ st State }

func (m *memPersist) Save(s State) error   { m.st = s; return nil }
func (m *memPersist) Load() (State, error) { return m.st, nil }

func TestTheStateSurvivesARestart(t *testing.T) {
	p := &memPersist{}
	q, c := fixture(t, Config{Persist: p})
	claim(t, q, "mac", "a", 0)
	b := claim(t, q, "mac", "b", 4)
	again, err := New(Config{Now: c.now, Persist: p})
	require.NoError(t, err)
	st, err := again.Status("mac")
	require.NoError(t, err)
	assert.Equal(t, []string{"a"}, names(st.Holders))
	assert.Equal(t, []string{"b"}, names(st.Queue))
	next, _ := again.Claim("mac", Claimant{Agent: "z"})
	assert.Greater(t, next.Entry.ID, b.Entry.ID, "ids go on from where they were")
}

func TestManyAgentsAtOnceNeverShareASlot(t *testing.T) {
	q, _ := fixture(t, Config{MaxPerAgent: 1000})
	require.NoError(t, q.Define(Resource{Key: "mac", Slots: 2}))
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a := string(rune('A' + i))
			_, _ = q.Claim("mac", Claimant{Agent: a, Priority: i % 5})
			st, _ := q.Status("mac")
			assert.LessOrEqual(t, len(st.Holders), 2)
			_ = q.Release("mac", a)
		}(i)
	}
	wg.Wait()
	st, _ := q.Status("mac")
	assert.Empty(t, st.Holders)
	assert.Empty(t, st.Queue)
	assert.Len(t, q.All(), 1)
}

// The Orchestrator's ruling (#13613): no starvation is the intent, so with the defaults a waiting entry gains one whole rank step of the board's task priorities (10) in about 30 minutes.
func TestWithTheDefaultsWaitingCrossesOneRankStepInHalfAnHour(t *testing.T) {
	q, c := fixture(t, Config{})
	claim(t, q, "mac", "holder", 0)
	claim(t, q, "mac", "low-waiting", 0)
	c.add(31 * time.Minute)
	claim(t, q, "mac", "fresh-medium", 10)
	st, _ := q.Status("mac")
	assert.Equal(t, []string{"low-waiting", "fresh-medium"}, names(st.Queue), "a low task that has waited half an hour is not behind a fresh medium one")
	claim(t, q, "mac", "fresh-high", 20)
	st, _ = q.Status("mac")
	assert.Equal(t, "fresh-high", st.Queue[0].Agent, "but it does not pass a class two steps up")
}

func TestRemovingAResourceDropsItsEntriesSoARedefinedOneStartsEmpty(t *testing.T) {
	q, _ := fixture(t, Config{})
	claim(t, q, "mac", "a", 0)
	claim(t, q, "mac", "b", 0)
	require.NoError(t, q.Remove("mac"))
	require.NoError(t, q.Define(Resource{Key: "mac", Slots: 1}))
	st, _ := q.Status("mac")
	assert.Empty(t, st.Holders, "nobody inherits a slot of the old resource")
	assert.Empty(t, st.Queue)
	assert.Empty(t, q.Snapshot().Entries)
}

func TestOnGrantIsCalledWhenMoreSlotsOrAKickGrantTheWaiting(t *testing.T) {
	var granted []string
	q, _ := fixture(t, Config{OnGrant: func(e Entry) { granted = append(granted, e.Agent) }})
	h := claim(t, q, "mac", "holder", 0)
	claim(t, q, "mac", "w1", 0)
	claim(t, q, "mac", "w2", 0)
	require.NoError(t, q.Define(Resource{Key: "mac", Slots: 2}))
	assert.Equal(t, []string{"w1"}, granted, "a slot added to the resource grants the next in line, and says so")
	require.NoError(t, q.Cancel(h.Entry.ID))
	assert.Equal(t, []string{"w1", "w2"}, granted, "a kick grants the next in line, and says so")
}
