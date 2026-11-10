package background

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #14863 (the Operator): every StaleSweepHours the monitor types ONE message to the orchestrator listing stale tasks and the commands to act on them. It waits for the orchestrator to be out of its turn,
// sends nothing when nothing is stale, never changes a task, and the setting turns it off. Driven with a fake clock (h.now).

func staleHarness(t *testing.T, hours int) *checkHarness {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, time.Hour) // idle: not in a turn
	h.member("Dev", "Developer", 2, time.Hour)
	hs := board.DefaultHealthSettings()
	hs.StaleSweepHours = hours
	require.NoError(t, h.s.SetHealthSettings(context.Background(), "team", hs))
	return h
}

func (h *checkHarness) sweeps() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, text := range h.sent["Orchestrator"] {
		if strings.Contains(text, "[Coral stale-task sweep]") {
			out = append(out, text)
		}
	}
	return out
}

func TestTheStaleSweepGoesOnceEveryPeriodWithTheCommandsAndChangesNothing(t *testing.T) {
	h := staleHarness(t, 12)
	ctx := context.Background()
	task, err := h.s.CreateTask(ctx, "team", "An old pending task", "", "medium", "Orchestrator", "Dev")
	require.NoError(t, err)
	start := h.now

	h.m.scan(ctx) // the first look starts the clock: nothing at once
	assert.Empty(t, h.sweeps(), "the first look sends nothing")

	h.now = start.Add(11 * time.Hour)
	h.m.scan(ctx)
	assert.Empty(t, h.sweeps(), "not due before 12 hours")

	h.now = start.Add(4 * 24 * time.Hour) // the task is over 3 days old, the period is due
	h.m.scan(ctx)
	got := h.sweeps()
	require.Len(t, got, 1, "ONE message")
	assert.Contains(t, got[0], "Pending more than 3 days")
	assert.Contains(t, got[0], "#"+strconv.FormatInt(task.ID, 10)+" ")
	for _, cmd := range []string{"coral-board task show N", "coral-board task complete N --message", "coral-board task reassign N --to", "coral-board task release N", "coral-board goal close"} {
		assert.Contains(t, got[0], cmd, "the message gives the command")
	}
	assert.Contains(t, got[0], "Coral changed nothing")
	after, err := h.s.GetTask(ctx, "team", task.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", after.Status, "the sweep changed no task")
	require.NotNil(t, after.AssignedTo)
	assert.Equal(t, "Dev", *after.AssignedTo)

	h.now = start.Add(4*24*time.Hour + 5*time.Hour)
	h.m.scan(ctx)
	assert.Len(t, h.sweeps(), 1, "not again within the period")
	h.now = start.Add(4*24*time.Hour + 13*time.Hour)
	h.m.scan(ctx)
	assert.Len(t, h.sweeps(), 2, "again after another 12 hours, the task still stale")
}

func TestTheStaleSweepWaitsForTheOrchestratorToBeOutOfItsTurnAndIsOffWhenTheSettingIsZero(t *testing.T) {
	h := staleHarness(t, 12)
	ctx := context.Background()
	_, err := h.s.CreateTask(ctx, "team", "Old", "", "medium", "Orchestrator", "Dev")
	require.NoError(t, err)
	start := h.now
	h.m.scan(ctx)
	h.now = start.Add(4 * 24 * time.Hour)
	h.sig["00000001-0000-0000-0000-000000000000"] = agentSignal{InTurn: true, Since: h.now} // the orchestrator is mid-turn
	h.m.scan(ctx)
	assert.Empty(t, h.sweeps(), "no interruption mid-turn")
	h.sig["00000001-0000-0000-0000-000000000000"] = agentSignal{Since: h.now.Add(-time.Minute)} // idle again
	h.m.scan(ctx)
	assert.Len(t, h.sweeps(), 1, "it goes at the next scan, when the orchestrator is idle")

	off := staleHarness(t, 0)
	_, err = off.s.CreateTask(ctx, "team", "Old", "", "medium", "Orchestrator", "Dev")
	require.NoError(t, err)
	s0 := off.now
	off.m.scan(ctx)
	off.now = s0.Add(10 * 24 * time.Hour)
	off.m.scan(ctx)
	assert.Empty(t, off.sweeps(), "0 hours is off")
}

func TestTheStaleSweepNamesEachKindOfStaleTaskAndLeavesFreshOnesOut(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }
	str := func(s string) *string { return &s }
	goal := int64(9)
	in := staleInput{
		Now: now,
		Open: []board.Task{
			{ID: 1, Title: "old pending", Status: "pending", AssignedTo: str("Dev"), CreatedAt: ago(4 * 24 * time.Hour)},
			{ID: 2, Title: "fresh pending", Status: "pending", AssignedTo: str("Dev"), CreatedAt: ago(2 * time.Hour)},
			{ID: 3, Title: "silent in progress", Status: "in_progress", AssignedTo: str("Dev"), CreatedAt: ago(30 * time.Hour), ClaimedAt: str(ago(30 * time.Hour))},
			{ID: 4, Title: "in progress, but it posted", Status: "in_progress", AssignedTo: str("QA"), CreatedAt: ago(30 * time.Hour), ClaimedAt: str(ago(30 * time.Hour))},
			{ID: 5, Title: "asleep owner", Status: "pending", AssignedTo: str("Sleepy"), CreatedAt: ago(time.Hour)},
			{ID: 6, Title: "gone owner", Status: "in_progress", AssignedTo: str("Gone"), CreatedAt: ago(time.Hour), ClaimedAt: str(ago(time.Hour))},
			{ID: 7, Title: "goal closed", Status: "pending", AssignedTo: str("Dev"), CreatedAt: ago(time.Hour), GoalID: &goal},
			{ID: 8, Title: "parked", Status: "pending", AssignedTo: str("Dev"), CreatedAt: ago(9 * 24 * time.Hour)},
		},
		InReview: []board.Task{
			{ID: 10, Title: "old review", Status: "review_pending", CreatedAt: ago(5 * 24 * time.Hour), Workflow: board.TaskWorkflow{CompletionReview: &board.CompletionReview{SubmittedAt: ago(26 * time.Hour)}}},
			{ID: 11, Title: "new review", Status: "review_pending", CreatedAt: ago(5 * 24 * time.Hour), Workflow: board.TaskWorkflow{CompletionReview: &board.CompletionReview{SubmittedAt: ago(2 * time.Hour)}}},
		},
		Asleep: map[string]bool{"sleepy": true}, Gone: map[string]bool{"gone": true},
		LastPost:   map[string]time.Time{"qa": now.Add(-time.Hour), "dev": now.Add(-40 * time.Hour)},
		GoalClosed: map[int64]bool{9: true},
		Parked:     func(t board.Task) bool { return t.ID == 8 },
		Title:      func(s string) string { return s },
	}
	text, n := staleSweepText(in)
	assert.Equal(t, 6, n, text)
	for _, want := range []string{"#1 old pending", "#3 silent in progress", "#10 old review", "#5 asleep owner", "#6 gone owner", "#7 goal closed"} {
		assert.Contains(t, text, want)
	}
	for _, not := range []string{"fresh pending", "but it posted", "new review", "parked"} {
		assert.NotContains(t, text, not)
	}
	none, zero := staleSweepText(staleInput{Now: now, Title: in.Title})
	assert.Equal(t, "", none)
	assert.Equal(t, 0, zero)
}

// The goal-closed case through the real store: a task on a goal that was closed is named, one on an open goal is not.
func TestTheStaleSweepNamesATaskOfAClosedGoal(t *testing.T) {
	h := staleHarness(t, 12)
	ctx := context.Background()
	closedGoal, err := h.s.CreateGoal(ctx, "team", board.GoalInput{Title: "Old goal", DoneWhen: "x"})
	require.NoError(t, err)
	openGoal, err := h.s.CreateGoal(ctx, "team", board.GoalInput{Title: "Live goal", DoneWhen: "y"})
	require.NoError(t, err)
	onClosed, err := h.s.CreateTask(ctx, "team", "Task of the closed goal", "", "low", "Orchestrator", "Dev")
	require.NoError(t, err)
	onOpen, err := h.s.CreateTask(ctx, "team", "Task of the open goal", "", "low", "Orchestrator", "Dev")
	require.NoError(t, err)
	cg, og := closedGoal.ID, openGoal.ID
	require.NoError(t, h.s.SetTaskGoal(ctx, "team", onClosed.ID, &cg))
	require.NoError(t, h.s.SetTaskGoal(ctx, "team", onOpen.ID, &og))
	_, _, err = h.s.CloseGoal(ctx, "team", cg, "done", board.GoalDone)
	require.NoError(t, err)
	start := h.now
	h.m.scan(ctx)
	h.now = start.Add(13 * time.Hour)
	h.m.scan(ctx)
	got := h.sweeps()
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "Open tasks of a goal that is closed: #"+strconv.FormatInt(onClosed.ID, 10)+" quoted: Task of the closed goal")
	assert.NotContains(t, got[0], "Task of the open goal")
}

// A typed notice has no parentheses (PowerShell reads them as sub-expressions: the v2.0.64 Windows reds): the sweep's text, in full, with more than the shown tasks in a group.
func TestTheStaleSweepTextHasNoParentheses(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	who := "Dev"
	var open []board.Task
	for i := 1; i <= 12; i++ {
		open = append(open, board.Task{ID: int64(i), Title: "old", Status: "pending", AssignedTo: &who, CreatedAt: now.Add(-5 * 24 * time.Hour).Format(time.RFC3339)})
	}
	text, n := staleSweepText(staleInput{Now: now, Open: open, Title: func(s string) string { return s }})
	assert.Equal(t, 12, n)
	assert.Contains(t, text, "and 4 more: see coral-board task list")
	assert.NotContains(t, text, "(")
	assert.NotContains(t, text, ")")
}
