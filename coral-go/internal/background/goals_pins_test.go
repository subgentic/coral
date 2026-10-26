package background

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/claudestub"
	"github.com/subgentic/coral/internal/store"
)

// #8443: what pollOnce and generate keep and record, pinned before they are split into named steps (the rules a mutation run of both found unpinned).

const goalPinSession = "00000000-0000-0000-0000-00000000b%03d"

func goalPinFixture(t *testing.T, n int) *goalFixture {
	t.Helper()
	return newGoalFixture(t, store.LiveSession{SessionID: strings.Replace(goalPinSession, "%03d", string(rune('0'+n/100))+string(rune('0'+n/10%10))+string(rune('0'+n%10)), 1), AgentType: "claude", AgentName: "coral-go"})
}

func (f *goalFixture) state() goalState {
	f.gen.mu.Lock()
	defer f.gen.mu.Unlock()
	if st := f.gen.states[f.sid]; st != nil {
		return *st
	}
	return goalState{}
}

func (f *goalFixture) tracked() bool {
	f.gen.mu.Lock()
	defer f.gen.mu.Unlock()
	_, ok := f.gen.states[f.sid]
	return ok
}

func (f *goalFixture) newRequest(t *testing.T, text string) {
	t.Helper()
	f.appendTranscript(t,
		`{"type":"user","message":{"role":"user","content":"`+text+`"},"timestamp":"2026-09-21T12:00:00Z"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it."}]},"timestamp":"2026-09-21T12:00:05Z"}`)
}

// The metrics are pruned at most once an hour, on a poll.
func TestGoalPollPrunesTheMetricsOncePerHour(t *testing.T) {
	f := goalPinFixture(t, 1)
	advance := f.fakeClock(t)
	f.poll()
	first := f.gen.lastPrune
	require.False(t, first.IsZero(), "the first poll prunes")
	advance(10 * time.Minute)
	f.poll()
	assert.Equal(t, first, f.gen.lastPrune, "10 minutes later: not again")
	advance(61 * time.Minute)
	f.poll()
	assert.True(t, f.gen.lastPrune.After(first), "an hour later: again")
}

// A poll that cannot list the live sessions changes nothing: the states of the sessions it knows stay.
func TestGoalPollKeepsItsStatesWhenTheSessionListFails(t *testing.T) {
	f := goalPinFixture(t, 2)
	f.poll()
	require.True(t, f.tracked())
	_, err := f.db.Exec(`ALTER TABLE live_sessions RENAME TO live_sessions_gone`)
	require.NoError(t, err)
	f.poll()
	assert.True(t, f.tracked(), "the list failed: the session is not forgotten")
	assert.False(t, f.gen.lastPoll.IsZero())
}

// A session that ended is forgotten: its state goes.
func TestGoalPollForgetsASessionThatEnded(t *testing.T) {
	f := goalPinFixture(t, 3)
	f.poll()
	require.True(t, f.tracked())
	require.NoError(t, f.ss.UnregisterLiveSession(f.ctx, f.sid))
	f.poll()
	assert.False(t, f.tracked(), "the state of an ended session goes")
}

// The missing-CLI note is once per outage: when the CLI comes back and goes again, it is a new outage.
func TestGoalAMissingCLIIsNotedOncePerOutage(t *testing.T) {
	f := goalPinFixture(t, 4)
	advance := f.fakeClock(t)
	f.gen.resolveCLI = func(map[string]string) string { return "" }
	f.poll()
	assert.Equal(t, []string{"first:no_cli"}, outcomes(f.attempts(t)))
	assert.False(t, f.state().inFlight, "nothing is left in flight")

	advance(time.Minute)
	f.gen.resolveCLI = func(map[string]string) string { return f.cli }
	f.appendTranscript(t, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"More."}]},"timestamp":"2026-09-21T12:00:05Z"}`)
	f.poll()
	assert.Equal(t, int32(1), f.calls.Load(), "the CLI is back: the goal is made")

	advance(31 * time.Minute)
	f.newRequest(t, "A different task")
	f.gen.resolveCLI = func(map[string]string) string { return "" }
	f.poll()
	assert.Equal(t, []string{"first:no_cli", "first:stored", "turn_end:no_cli"}, outcomes(f.attempts(t)), "a second outage is noted again")
}

// A signed-out claude is never started: the goal waits, nothing is counted against the session, and it is made once claude is signed in.
func TestGoalASignedOutClaudeWaitsAndIsNotCounted(t *testing.T) {
	f := goalPinFixture(t, 5)
	f.cli = claudestub.New(t, claudestub.SignedOut).Path()
	f.poll()
	assert.Equal(t, int32(0), f.calls.Load(), "signed out: no run")
	assert.Empty(t, f.attempts(t), "no attempt is recorded")
	st := f.state()
	assert.False(t, st.inFlight, "nothing is left in flight")
	assert.Zero(t, st.failures)

	f.cli = signedInClaude(t)
	f.poll()
	assert.Equal(t, int32(1), f.calls.Load(), "signed in: the goal is made")
}

// A failure is counted and backs the session off; a success clears both.
func TestGoalFailuresCountAndASuccessClearsThem(t *testing.T) {
	f := goalPinFixture(t, 6)
	advance := f.fakeClock(t)
	f.err = errors.New("exit status 1")
	f.poll()
	st := f.state()
	assert.Equal(t, 1, st.failures)
	assert.False(t, st.failedAt.IsZero())
	assert.False(t, st.inFlight)

	advance(31 * time.Minute)
	f.appendTranscript(t, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"More."}]},"timestamp":"2026-09-21T12:00:05Z"}`)
	f.poll()
	assert.Equal(t, 2, f.state().failures, "a second failure in a row")

	f.err = nil
	advance(61 * time.Minute)
	f.appendTranscript(t, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Again."}]},"timestamp":"2026-09-21T12:00:06Z"}`)
	f.poll()
	st = f.state()
	assert.Zero(t, st.failures, "a success clears the count")
	assert.True(t, st.failedAt.IsZero(), "and the backoff")
	assert.False(t, st.generatedAt.IsZero())
}

// After a generation the state holds the transcript's size, so an unchanged transcript is not read again.
func TestGoalTheTranscriptSizeIsRemembered(t *testing.T) {
	f := goalPinFixture(t, 7)
	f.poll()
	info, err := os.Stat(f.path)
	require.NoError(t, err)
	assert.Equal(t, info.Size(), f.state().size)
}

// A transcript that was replaced by a shorter one is read from its start: the new request is the one the CLI is given.
func TestGoalAReplacedTranscriptIsReadAgain(t *testing.T) {
	f := goalPinFixture(t, 8)
	advance := f.fakeClock(t)
	f.appendTranscript(t, strings.Repeat(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"padding padding padding"}]},"timestamp":"2026-09-21T11:00:06Z"}`+"\n", 20))
	f.poll()
	require.Equal(t, int32(1), f.calls.Load())

	require.NoError(t, os.WriteFile(f.path, []byte(
		`{"type":"user","message":{"role":"user","content":"Write the release notes"},"timestamp":"2026-09-21T13:00:00Z"}`+"\n"+
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Drafting."}]},"timestamp":"2026-09-21T13:00:05Z"}`+"\n"), 0o644))
	advance(time.Minute)
	f.gen.RequestGoal(f.sid) // a shorter file is not "new bytes": the operator's refresh is what asks again
	f.poll()
	assert.Equal(t, int32(2), f.calls.Load())
	assert.Contains(t, f.prompt, "LATEST USER REQUEST:\nWrite the release notes")
	assert.NotContains(t, f.prompt, "Make the sidebar goal line quieter")
}

// After a restart, only a goal the generator made itself lends its basis: a goal of unknown source made from the same requests is asked for again.
func TestGoalARestartTrustsTheBasisOfAnAutoGoalOnly(t *testing.T) {
	f := goalPinFixture(t, 9)
	basis := goalBasis(goalInput{Request: "Make the sidebar goal line quieter"})
	detail := `{"basis":"` + basis + `"}` // no source: a goal of the days before sources
	sid := f.sid
	_, err := f.ts.InsertAgentEvent(f.ctx, &store.AgentEvent{AgentName: "coral-go", SessionID: &sid, EventType: GoalEventType, Summary: "Older goal", DetailJSON: &detail})
	require.NoError(t, err)
	f.poll()
	assert.Equal(t, int32(1), f.calls.Load(), "a goal without a source is not trusted: the CLI runs")

	g := goalPinFixture(t, 10)
	autoDetail := `{"source":"auto","basis":"` + basis + `"}`
	sid = g.sid
	_, err = g.ts.InsertAgentEvent(g.ctx, &store.AgentEvent{AgentName: "coral-go", SessionID: &sid, EventType: GoalEventType, Summary: "Auto goal", DetailJSON: &autoDetail})
	require.NoError(t, err)
	g.poll()
	assert.Equal(t, int32(0), g.calls.Load(), "an automatic goal made from the same requests stands")
}

// A goal the model repeats is recorded as unchanged and stores nothing; a goal that is new is stored under the agent and the session with the basis it was made from.
func TestGoalWhatIsStoredAndRecorded(t *testing.T) {
	f := goalPinFixture(t, 11)
	f.gen.runCLI = func(_ context.Context, _, prompt string) (goalCLIResult, error) {
		time.Sleep(20 * time.Millisecond)
		return goalCLIResult{Text: f.reply, CostUSD: 0.5, InputTokens: 1, OutputTokens: 2, CacheReadTokens: 7, CacheWriteTokens: 9}, nil
	}
	f.poll()
	rows := f.attempts(t)
	require.Len(t, rows, 1)
	assert.GreaterOrEqual(t, rows[0].DurationMs, int64(20), "the time the CLI took")
	assert.Equal(t, int64(7), rows[0].CacheReadTokens)
	assert.Equal(t, int64(9), rows[0].CacheWriteTokens)
	assert.Equal(t, int64(1), rows[0].InputTokens)
	assert.Equal(t, int64(2), rows[0].OutputTokens)

	ev, err := f.ts.GetLatestGoalEvent(f.ctx, f.sid)
	require.NoError(t, err)
	require.NotNil(t, ev)
	assert.Equal(t, "coral-go", ev.AgentName, "the agent's name")
	require.NotNil(t, ev.SessionID)
	assert.Equal(t, f.sid, *ev.SessionID)
	require.NotNil(t, ev.DetailJSON)
	assert.Contains(t, *ev.DetailJSON, `"source":"auto"`)
	assert.Contains(t, *ev.DetailJSON, `"basis":"`+goalBasis(goalInput{Request: "Make the sidebar goal line quieter"})+`"`)
}

// What the CLI says is cut to 500 characters in the record, an error and an unusable reply alike.
func TestGoalLongErrorsAreCutInTheRecord(t *testing.T) {
	f := goalPinFixture(t, 12)
	advance := f.fakeClock(t)
	f.err = errors.New(strings.Repeat("é", 600))
	f.poll()
	rows := f.attempts(t)
	require.Len(t, rows, 1)
	assert.Equal(t, 501, utf8.RuneCountInString(rows[0].Error), "500 characters and the ellipsis")

	f.err = nil
	f.reply = strings.Repeat(`"`, 700) // nothing but quotes: no goal in it
	advance(31 * time.Minute)
	f.appendTranscript(t, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"More."}]},"timestamp":"2026-09-21T12:00:05Z"}`)
	f.gen.RequestGoal(f.sid)
	f.poll()
	rows = f.attempts(t)
	require.Len(t, rows, 2)
	assert.Equal(t, store.GoalOutcomeBadOutput, rows[1].Outcome)
	assert.True(t, strings.HasPrefix(rows[1].Error, "unusable reply: "))
	assert.LessOrEqual(t, utf8.RuneCountInString(rows[1].Error), 501)
}

// A goal that cannot be stored is a failed attempt with its reason, not a stored one.
func TestGoalAFailedStoreIsAFailedAttempt(t *testing.T) {
	f := goalPinFixture(t, 13)
	_, err := f.db.Exec(`ALTER TABLE agent_events RENAME TO agent_events_gone`)
	require.NoError(t, err)
	f.poll()
	rows := f.attempts(t)
	require.Len(t, rows, 1)
	assert.Equal(t, store.GoalOutcomeFailed, rows[0].Outcome)
	assert.True(t, strings.HasPrefix(rows[0].Error, "store goal: "), rows[0].Error)
	assert.Equal(t, 1, f.state().failures, "and it counts as a failure")
}

// A goal that is gone (nothing stored) is made again for the same requests: the basis only spares the CLI while there is a goal to keep.
func TestGoalAGoalThatIsGoneIsMadeAgainForTheSameRequests(t *testing.T) {
	f := goalPinFixture(t, 14)
	advance := f.fakeClock(t)
	f.poll()
	require.Equal(t, int32(1), f.calls.Load())
	_, err := f.db.Exec(`DELETE FROM agent_events WHERE event_type = ?`, GoalEventType)
	require.NoError(t, err)

	advance(31 * time.Minute)
	f.appendTranscript(t, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"More."}]},"timestamp":"2026-09-21T12:00:05Z"}`)
	f.poll()
	assert.Equal(t, int32(2), f.calls.Load(), "no goal stored: the CLI runs again for the same requests")
	goal, _ := f.latest(t)
	assert.Equal(t, "Quiet the sidebar goal line", goal)
}
