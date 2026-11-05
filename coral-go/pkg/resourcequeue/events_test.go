package resourcequeue

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13671: the queue tells a sink of each change (what the analytics keep): who, which resource, how long it waited or held, and why it ended. No command and no note ever travels in it.

type sink struct {
	mu sync.Mutex
	ev []Event
}

func (s *sink) add(e Event) { s.mu.Lock(); s.ev = append(s.ev, e); s.mu.Unlock() }
func (s *sink) kinds() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, e := range s.ev {
		out = append(out, e.Kind+":"+e.Agent)
	}
	return out
}
func (s *sink) last() Event { s.mu.Lock(); defer s.mu.Unlock(); return s.ev[len(s.ev)-1] }

func TestEventsTellEachChangeWithTheWaitAndTheHold(t *testing.T) {
	s := &sink{}
	q, c := fixture(t, Config{OnEvent: s.add})
	claim(t, q, "mac", "a", 0) // granted at once
	claim(t, q, "mac", "b", 0) // waits
	c.add(5 * time.Minute)
	require.NoError(t, q.Release("mac", "a")) // a held 5 m; b is granted after waiting 5 m
	assert.Equal(t, []string{"enqueued:a", "granted:a", "enqueued:b", "released:a", "granted:b"}, s.kinds())
	g := s.last()
	assert.Equal(t, 5*time.Minute, g.Wait, "b waited five minutes in line")
	s.mu.Lock()
	rel := s.ev[3]
	granted0 := s.ev[1]
	s.mu.Unlock()
	assert.Equal(t, 5*time.Minute, rel.Held)
	assert.Equal(t, time.Duration(0), granted0.Wait, "a slot given at once waited nothing")
}

func TestEventsNameAKickALeaseThatRanOutAndAGoneAgent(t *testing.T) {
	s := &sink{}
	alive := map[string]bool{"a": true, "b": true, "c": true}
	q, c := fixture(t, Config{OnEvent: s.add, Alive: func(a string) bool { return alive[a] }})
	r := claim(t, q, "mac", "a", 0)
	claim(t, q, "mac", "b", 0)
	require.NoError(t, q.Cancel(r.Entry.ID)) // the Operator's kick of the holder; b is granted
	assert.Contains(t, s.kinds(), "kicked:a")
	c.add(DefaultLease + time.Minute)
	_, err := q.Reap() // b's lease ran out
	require.NoError(t, err)
	assert.Contains(t, s.kinds(), "expired:b")
	claim(t, q, "mac", "c", 0)
	alive["c"] = false
	_, err = q.Reap()
	require.NoError(t, err)
	assert.Contains(t, s.kinds(), "gone:c")
}

func TestEventsCarryTheViaAndPatternAndNothingElse(t *testing.T) {
	s := &sink{}
	q, _ := fixture(t, Config{OnEvent: s.add})
	_, err := q.Claim("mac", Claimant{Agent: "a", Task: 7, Via: "hook", Pattern: "go test ./...", Note: "auto: secret words"})
	require.NoError(t, err)
	e := s.ev[0]
	assert.Equal(t, "hook", e.Via)
	assert.Equal(t, "go test ./...", e.Pattern)
	assert.Equal(t, 7, e.Task)
	assert.NotContains(t, e.Resource+e.Agent+e.Via+e.Pattern, "secret", "the note is not an event field")
}

func TestASinkThatPanicsOrReadsTheQueueNeverBreaksAClaim(t *testing.T) {
	var q *Queue
	var c *clock
	q, c = fixture(t, Config{OnEvent: func(e Event) {
		_, _ = q.Status("mac") // called outside the lock: reading the queue from the sink must not deadlock
		panic("a bad sink")
	}})
	_ = c
	r, err := q.Claim("mac", Claimant{Agent: "a"})
	require.NoError(t, err)
	assert.True(t, r.Granted, "the claim stands whatever the sink does")
	require.NoError(t, q.Release("mac", "a"))
}

func TestAnEventCarriesTheBoardOfTheTaskAndAHookReleaseTheReasonItGives(t *testing.T) {
	s := &sink{}
	q, _ := fixture(t, Config{OnEvent: s.add})
	_, err := q.Claim("mac", Claimant{Agent: "a", Task: 7, Project: "team"})
	require.NoError(t, err)
	assert.Equal(t, "team", s.ev[0].Project)
	require.NoError(t, q.ReleaseWhy("mac", "a", "call ended"))
	rel := s.last()
	assert.Equal(t, "released", rel.Kind)
	assert.Equal(t, "call ended", rel.Why)
	assert.Equal(t, "team", rel.Project)
	_, err = q.Claim("mac", Claimant{Agent: "b"})
	require.NoError(t, err)
	require.NoError(t, q.Release("mac", "b"))
	assert.Equal(t, "", s.last().Why, "a hand release says no reason of its own")
}

// #13724 with #13706 and #13718: a slot given back with a reason, a place kept for an agent that is away and the kept place that ran out are each an event the history can say in words.
func TestLeaveTellsTheReasonAKeptPlaceAndTheEndOfAKeptPlace(t *testing.T) {
	s := &sink{}
	q, c := fixture(t, Config{OnEvent: s.add})
	claim(t, q, "mac", "a", 0)
	claim(t, q, "mac", "b", 0) // waits
	require.NoError(t, q.LeaveWhy("mac", "b", 10*time.Minute, "turn ended"))
	assert.Equal(t, "away", s.last().Kind, "the place is kept: not an end")
	assert.Equal(t, "turn ended", s.last().Why)
	c.add(11 * time.Minute)
	_, err := q.Reap()
	require.NoError(t, err)
	rel := s.last()
	assert.Equal(t, "cancelled", rel.Kind, "the kept place ran out")
	assert.Equal(t, "kept place", rel.Why)
	assert.Equal(t, "b", rel.Agent)
	require.NoError(t, q.LeaveWhy("mac", "a", 10*time.Minute, "job ended")) // a holder: the slot is given back
	assert.Equal(t, "released", s.last().Kind)
	assert.Equal(t, "job ended", s.last().Why)
	claim(t, q, "mac", "c", 0)
	claim(t, q, "mac", "d", 0) // waits
	require.NoError(t, q.LeaveWhy("mac", "d", 0, "gone"))
	assert.Equal(t, "cancelled", s.last().Kind, "no grace: the place goes")
	assert.Equal(t, "gone", s.last().Why)
}
