package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/limitwaits"
)

// #21020: the limit counter, against a scripted run: a fake clock, scripted agents and limits, and a real record.
type counterRig struct {
	t      *testing.T
	c      *LimitCounter
	st     *limitwaits.Store
	path   string
	now    time.Time
	agents map[string]AgentInfo
	limits map[string]limitRead
	teams  map[string]string
}

type limitRead struct {
	reset   time.Time
	limited bool
}

func newCounterRig(t *testing.T) *counterRig {
	t.Helper()
	path := filepath.Join(t.TempDir(), "limit_waits.db")
	st, err := limitwaits.Open(path)
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	r := &counterRig{t: t, st: st, path: path, now: time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC), agents: map[string]AgentInfo{}, limits: map[string]limitRead{}, teams: map[string]string{}}
	r.c = r.counter(st)
	return r
}

func (r *counterRig) counter(sink limitWaitSink) *LimitCounter {
	c := NewLimitCounter(time.Minute, sink)
	c.now = func() time.Time { return r.now }
	c.discover = func(context.Context) ([]AgentInfo, error) {
		var out []AgentInfo
		for _, a := range r.agents {
			out = append(out, a)
		}
		return out, nil
	}
	c.state = func(_ context.Context, a AgentInfo, _ time.Time) (time.Time, bool) {
		l := r.limits[a.SessionID]
		return l.reset, l.limited
	}
	c.teamOf = func(context.Context) map[string]string { return r.teams }
	return c
}

func (r *counterRig) agent(sid, name, team string) {
	r.agents[sid] = AgentInfo{AgentName: "claude-" + sid, AgentType: "claude", SessionID: sid, DisplayName: name}
	r.teams["claude-"+sid] = team
}

func (r *counterRig) limit(sid string, reset time.Time) {
	r.limits[sid] = limitRead{reset: reset, limited: true}
}
func (r *counterRig) clear(sid string) { delete(r.limits, sid) }

// tick advances the clock by d and looks once.
func (r *counterRig) tick(d time.Duration) {
	r.now = r.now.Add(d)
	r.c.Tick(context.Background())
}

func (r *counterRig) report() limitwaits.Report {
	rep, err := r.st.Counts(r.now.Add(-48*time.Hour), r.now.Add(time.Hour), "", time.UTC)
	require.NoError(r.t, err)
	return rep
}

func TestTheCounterCountsAScriptedRunExactly(t *testing.T) {
	r := newCounterRig(t)
	for _, a := range [][3]string{{"a", "Lead Developer", "alpha"}, {"b", "QA Engineer", "alpha"}, {"c", "Backend Dev", "alpha"}, {"d", "Docs", "alpha"}, {"e", "Flicker", "alpha"}, {"f", "Old Error", "alpha"}, {"g", "Orchestrator", "alpha"}} {
		r.agent(a[0], a[1], a[2])
	}
	start := r.now
	r.limit("a", start.Add(60*time.Minute))  // resumes at reset
	r.limit("b", start.Add(2*time.Hour))     // resumes early
	r.limit("c", start.Add(3*time.Hour))     // goes away
	r.limit("d", time.Time{})                // no reset time named
	r.limit("f", start.Add(-3*24*time.Hour)) // an error from three days ago in a transcript
	r.limit("g", start.Add(10*time.Minute))
	r.tick(0)
	for i := 0; i < 3; i++ { // the same limits read again and again are the same waits
		r.tick(time.Minute)
	}
	// e hits a limit, a read fails once, the limit is read again: one wait
	r.limit("e", start.Add(90*time.Minute))
	r.tick(time.Minute)
	r.clear("e")
	r.tick(time.Minute)
	r.limit("e", start.Add(90*time.Minute))
	r.tick(time.Minute)
	// b is resumed by a person 30 minutes in: gone from the limit for two looks
	r.clear("b")
	r.tick(time.Minute)
	r.tick(time.Minute)
	// d (no time) works again
	r.clear("d")
	r.tick(time.Minute)
	r.tick(time.Minute)
	// c goes away
	delete(r.agents, "c")
	r.tick(time.Minute)
	r.tick(time.Minute)
	// g works again after its reset
	r.now = start.Add(11 * time.Minute)
	r.clear("g")
	r.tick(time.Minute)
	r.tick(time.Minute)
	// a works again after its reset, e too (its reset at 90 minutes)
	r.now = start.Add(61 * time.Minute)
	r.clear("a")
	r.tick(time.Minute)
	r.tick(time.Minute)
	r.now = start.Add(95 * time.Minute)
	r.clear("e")
	r.tick(time.Minute)
	r.tick(time.Minute)

	rep := r.report()
	// waits: a b c d e g = 6 (f is old); at reset: a, e, g = 3; early: b = 1; c is gone and d has no time: neither
	assert.Equal(t, limitwaits.Totals{Waits: 6, AtReset: 3, Early: 1}, rep.Totals)
	assert.Equal(t, 0, rep.Waiting, "every wait has ended")
	byAgent := map[string]limitwaits.Row{}
	for _, row := range rep.Rows {
		byAgent[row.Agent] = row
	}
	assert.Equal(t, limitwaits.Row{Agent: "Lead Developer", Day: "2026-11-23", Waits: 1, AtReset: 1}, byAgent["Lead Developer"])
	assert.Equal(t, limitwaits.Row{Agent: "QA Engineer", Day: "2026-11-23", Waits: 1, Early: 1}, byAgent["QA Engineer"])
	assert.Equal(t, limitwaits.Row{Agent: "Backend Dev", Day: "2026-11-23", Waits: 1}, byAgent["Backend Dev"])
	assert.Equal(t, limitwaits.Row{Agent: "Docs", Day: "2026-11-23", Waits: 1}, byAgent["Docs"])
	assert.Equal(t, limitwaits.Row{Agent: "Flicker", Day: "2026-11-23", Waits: 1, AtReset: 1}, byAgent["Flicker"], "a read that fails once is not the end of a wait and the start of another")
	assert.Equal(t, limitwaits.Row{Agent: "Old Error", Day: "2026-11-23"}, byAgent["Old Error"], "an error whose reset is three days old is not a wait: the agent is a row with none")
}

func TestAnAgentThatStillWaitsIsNotCountedTwiceAfterARestart(t *testing.T) {
	r := newCounterRig(t)
	r.agent("a", "Lead Developer", "alpha")
	r.limit("a", r.now.Add(time.Hour))
	r.tick(0)
	require.Equal(t, 1, r.report().Totals.Waits)
	// the server restarts: a new counter on the same record, the agent still limited
	r.c = r.counter(r.st)
	r.tick(time.Minute)
	r.tick(time.Minute)
	assert.Equal(t, 1, r.report().Totals.Waits, "the open wait was taken up again, not counted anew")
	assert.Equal(t, 1, r.report().Waiting)
	// and the original row is the one that is closed when the agent works again
	r.now = r.now.Add(time.Hour)
	r.clear("a")
	r.tick(time.Minute)
	r.tick(time.Minute)
	rep := r.report()
	assert.Equal(t, limitwaits.Totals{Waits: 1, AtReset: 1}, rep.Totals)
	assert.Equal(t, 0, rep.Waiting)
}

func TestAResetThatDriftsBySecondsIsTheSameWaitAndAnotherLimitAfterTheResetIsANewOne(t *testing.T) {
	r := newCounterRig(t)
	r.agent("a", "Lead Developer", "alpha")
	reset := r.now.Add(time.Hour)
	r.limit("a", reset)
	r.tick(0)
	r.limit("a", reset.Add(40*time.Second)) // a screen's "in 59 minutes" drifts
	r.tick(time.Minute)
	assert.Equal(t, 1, r.report().Totals.Waits)
	// the first reset comes, the agent works and hits the next limit before the counter saw it work
	r.now = reset.Add(2 * time.Minute)
	r.limit("a", reset.Add(5*time.Hour))
	r.c.Tick(context.Background())
	rep := r.report()
	assert.Equal(t, limitwaits.Totals{Waits: 2, AtReset: 1}, rep.Totals, "the first ended at its reset, the second waits")
	assert.Equal(t, 1, rep.Waiting)
}

func TestTheTeamOfAnAgentIsRecordedWithItsWait(t *testing.T) {
	r := newCounterRig(t)
	r.agent("a", "Lead Developer", "beta")
	r.limit("a", r.now.Add(time.Hour))
	r.tick(0)
	rep, err := r.st.Counts(r.now.Add(-time.Hour), r.now.Add(time.Hour), "beta", time.UTC)
	require.NoError(t, err)
	assert.Equal(t, 1, rep.Totals.Waits)
	rep, err = r.st.Counts(r.now.Add(-time.Hour), r.now.Add(time.Hour), "alpha", time.UTC)
	require.NoError(t, err)
	assert.Equal(t, 0, rep.Totals.Waits)
}

func TestACounterThatCannotWriteCountsNothingAndBreaksNothing(t *testing.T) {
	r := newCounterRig(t)
	require.NoError(t, r.st.Close()) // the file is closed: every write fails
	r.c = r.counter(r.st)
	r.agent("a", "Lead Developer", "alpha")
	r.limit("a", r.now.Add(time.Hour))
	assert.NotPanics(t, func() { r.tick(0); r.tick(time.Minute) })
}

// #21020 (the mock's zero row): the counter notes every agent it sees, so the card draws an agent that had no wait as 0, 0, 0 on a day that had some.
func TestEveryAgentTheCounterSeesIsARowWithZerosOnADayWithWaits(t *testing.T) {
	r := newCounterRig(t)
	r.agent("a", "Lead Developer", "alpha")
	r.agent("b", "Backend Dev", "alpha")
	r.agent("c", "Docs", "beta")
	r.limit("a", r.now.Add(time.Hour))
	r.tick(0)
	r.tick(time.Minute)
	rep, err := r.st.Counts(r.now.Add(-time.Hour), r.now.Add(time.Hour), "alpha", time.UTC)
	require.NoError(t, err)
	assert.Equal(t, []limitwaits.Row{{Agent: "Lead Developer", Day: "2026-11-23", Waits: 1}, {Agent: "Backend Dev", Day: "2026-11-23"}}, rep.Rows)
	assert.Equal(t, 1, rep.Totals.Waits)
}
