package board

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11225: the operator_touch table holds a kind, an agent, a team and a time, and nothing that could be text or a length. This pins the whole row: a column added to hold more fails here.
func TestOperatorTouchHoldsNoText(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	var cols []struct {
		Name string `db:"name"`
		Type string `db:"type"`
	}
	require.NoError(t, s.db.SelectContext(ctx, &cols, `SELECT name, type FROM pragma_table_info('operator_touch')`))
	var names []string
	for _, c := range cols {
		names = append(names, c.Name)
	}
	assert.Equal(t, []string{"id", "at", "kind", "team", "agent"}, names, "the table is the whole record: no column for text, a length or anything typed")

	// What is recorded is only what the signature takes: kind, team, agent and time. A secret typed, a long paste and a name written to look like text leave nothing but the kind and the agent.
	secret := "correct horse battery staple " + strings.Repeat("x", 4000)
	require.NoError(t, s.RecordOperatorTouch(ctx, "team", "Dev", TouchTyped, time.Now()))
	require.NoError(t, s.RecordOperatorTouch(ctx, "team", "Dev", TouchAnswer, time.Now()))
	var rows []struct {
		At, Kind, Team, Agent string
	}
	require.NoError(t, s.db.SelectContext(ctx, &rows, `SELECT at, kind, team, agent FROM operator_touch`))
	require.Len(t, rows, 2)
	dump, _ := json.Marshal(rows)
	assert.NotContains(t, string(dump), "correct horse")
	assert.Less(t, len(dump), 400, "the rows are a few bytes each: nothing in them grows with what was typed")
	_ = secret

	// A kind that is not one of the six, or no team or agent, is refused and stores nothing.
	for _, bad := range [][3]string{{"team", "Dev", "typed text"}, {"team", "Dev", ""}, {"", "Dev", TouchTyped}, {"team", "", TouchTyped}} {
		assert.ErrorIs(t, s.RecordOperatorTouch(ctx, bad[0], bad[1], bad[2], time.Now()), ErrBadTouch, fmt.Sprint(bad))
	}
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM operator_touch`))
	assert.Equal(t, 2, n)
}

func TestOperatorTouchesCountByKindDayAndAgent(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	rec := func(team, agent, kind string, ago time.Duration) {
		require.NoError(t, s.RecordOperatorTouch(ctx, team, agent, kind, now.Add(-ago)))
	}
	rec("team", "Dev", TouchTyped, time.Hour)
	rec("team", "Dev", TouchTyped, 2*time.Hour)
	rec("team", "Dev", TouchAnswer, 3*time.Hour)
	rec("team", "QA", TouchWake, 26*time.Hour)
	rec("team", "QA", TouchRestart, 27*time.Hour)
	rec("team", "QA", TouchStop, 50*time.Hour)
	rec("team", "QA", TouchApprove, 5*time.Hour)
	rec("other", "Dev", TouchTyped, time.Hour) // another team's
	since, until := activityWindow()
	got, err := s.OperatorTouches(ctx, "team", since, until)
	require.NoError(t, err)
	assert.Equal(t, TouchCount{Typed: 2, Answer: 1, Approve: 1, Wake: 1, Restart: 1, Stop: 0}, got.Kinds, "the stop is 50 h old: outside the 48 h window; the other team's touch is not counted")
	require.Len(t, got.Agents, 2)
	assert.Equal(t, "Dev", got.Agents[0].Name, "the agent with most touches first")
	assert.Equal(t, 3, got.Agents[0].Total())
	assert.Equal(t, 2, got.Agents[0].Typed)
	var total int
	for _, d := range got.Days {
		total += d.Total()
	}
	assert.Equal(t, got.Kinds.Total(), total)
	b, _ := json.Marshal(got)
	assert.Contains(t, string(b), `"typed":2`)
	assert.Contains(t, string(b), `"agents":[{"name":"Dev"`)

	// a window that is not forward, or longer than 90 days, is refused
	_, err = s.OperatorTouches(ctx, "team", until, since)
	assert.ErrorIs(t, err, ErrBadActivityWindow)
	_, err = s.OperatorTouches(ctx, "team", now.Add(-91*24*time.Hour).Format(time.RFC3339), until)
	assert.ErrorIs(t, err, ErrBadActivityWindow)
}

func TestOperatorTouchesAreKeptNinetyDays(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	require.NoError(t, s.RecordOperatorTouch(ctx, "team", "Dev", TouchTyped, now.Add(-89*24*time.Hour)))
	require.NoError(t, s.RecordOperatorTouch(ctx, "team", "Dev", TouchTyped, now.Add(-91*24*time.Hour)))
	require.NoError(t, s.RecordOperatorTouch(ctx, "team", "Dev", TouchStop, now.Add(-200*24*time.Hour)))
	n, err := s.PruneOperatorTouches(ctx, now)
	require.NoError(t, err)
	assert.EqualValues(t, 2, n)
	var left int
	require.NoError(t, s.db.GetContext(ctx, &left, `SELECT COUNT(*) FROM operator_touch`))
	assert.Equal(t, 1, left, "the 89 day old touch stays")
}

// Messages per agent and task: what an agent sent and received while it had a task in progress, within and across teams, Coral's own notices apart; no text in the result.
func TestTaskMessageCountsAreOfTheTimeATaskIsInProgress(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, n := range []string{"Orchestrator", "Dev", "QA"} {
		_, err := sub(s, ctx, "team", n, n)
		require.NoError(t, err)
	}
	task, err := s.CreateTask(ctx, "team", "build it", "", "medium", "Orchestrator", "Dev")
	require.NoError(t, err)
	post := func(who, text string) {
		_, err := s.PostMessage(ctx, "team", who, text, nil)
		require.NoError(t, err)
	}
	post("Dev", "before the claim: not counted") // the task is not in progress yet
	claimed := time.Now().UTC().Add(time.Second)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET claimed_at = ?, status = 'in_progress' WHERE id = ?`, claimed.Format(time.RFC3339), task.ID)
	require.NoError(t, err)
	time.Sleep(1200 * time.Millisecond) // sleep-ok: the posts below must carry a later timestamp than the claim
	post("Dev", "@QA can you look")
	post("Dev", "no mention")
	post("QA", "@Dev looked, fine")
	post("Orchestrator", "@Dev status?")
	post("Coral Task Queue", "@Dev [Task] reminder")
	post("Operator", "@Dev keep going")
	post("QA", "@Orchestrator unrelated")

	since, until := activityWindow()
	got, truncated, err := s.TaskMessageCounts(ctx, "team", since, until)
	require.NoError(t, err)
	assert.False(t, truncated)
	require.Len(t, got, 1, "only Dev's task: QA and the Orchestrator have none in progress")
	g := got[0]
	assert.Equal(t, task.ID, g.TaskID)
	assert.Equal(t, "Dev", g.Agent)
	assert.Equal(t, 2, g.Sent, "two posts while the task was in progress, not the one before the claim")
	assert.Equal(t, 2, g.Received, "QA's and the Orchestrator's @Dev; the Operator's post belongs to the operator tab")
	assert.Equal(t, 4, g.Within)
	assert.Zero(t, g.Across)
	assert.Equal(t, 1, g.Automated, "Coral's notice is counted apart")
	b, _ := json.Marshal(got)
	for _, text := range []string{"can you look", "looked, fine", "status?", "reminder", "keep going"} {
		assert.NotContains(t, string(b), text, "a count never carries a message's text")
	}

	// a completed task stops counting at its completion
	time.Sleep(1200 * time.Millisecond) // sleep-ok: the completion must fall in an earlier second than the post after it
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET completed_at = ?, status = 'completed' WHERE id = ?`, time.Now().UTC().Format(time.RFC3339), task.ID)
	require.NoError(t, err)
	time.Sleep(1200 * time.Millisecond) // sleep-ok: as above
	post("Dev", "after done")
	got, _, err = s.TaskMessageCounts(ctx, "team", since, until)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, 2, got[0].Sent, "a post after completion is not the task's")
	// the window is checked
	_, _, err = s.TaskMessageCounts(ctx, "team", until, since)
	assert.ErrorIs(t, err, ErrBadActivityWindow)
}
