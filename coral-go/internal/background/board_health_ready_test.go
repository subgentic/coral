package background

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// Two more lines of the orchestrator's check (#8975, goal #80): a goal whose every task has been done for the wait, and open tasks with no goal or no assignee after the wait.

type readyRig struct{ *checkHarness }

func newReadyRig(t *testing.T) *readyRig {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.settings(func(hs *board.HealthSettings) {
		hs.On = true
		hs.GoalsReady = board.HealthWaitCheck{On: true, WaitMin: 30}
		hs.UnownedTasks = board.HealthWaitCheck{On: true, WaitMin: 15}
	})
	return &readyRig{h}
}

// goalDone makes a goal with n tasks, all finished by Dev.
func (r *readyRig) goalDone(title string, n int) int64 {
	r.t.Helper()
	ctx := context.Background()
	g, err := r.s.CreateGoal(ctx, "team", board.GoalInput{Title: title, Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(r.t, err)
	r.moreDone(g.ID, n)
	return g.ID
}

func (r *readyRig) moreDone(goal int64, n int) {
	r.t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		task, err := r.s.CreateTaskWithOpts(ctx, "team", "work", "", "medium", "Operator", &board.CreateTaskOpts{GoalID: &goal}, "Dev")
		require.NoError(r.t, err)
		claimed, err := r.s.ClaimTask(ctx, "team", "Dev", task.ID)
		require.NoError(r.t, err)
		_, err = r.s.CompleteTask(ctx, "team", claimed.ID, "Dev", nil)
		require.NoError(r.t, err)
	}
}

func (r *readyRig) loose(n int) []int64 {
	r.t.Helper()
	var ids []int64
	for i := 0; i < n; i++ {
		task, err := r.s.CreateTaskWithOpts(context.Background(), "team", "loose", "", "medium", "Operator", nil)
		require.NoError(r.t, err)
		ids = append(ids, task.ID)
	}
	return ids
}

func TestAGoalWhoseTasksAreAllDoneIsOneLineAfterTheWait(t *testing.T) {
	r := newReadyRig(t)
	g := r.goalDone("Secret goal title", 2)
	assert.NotContains(t, r.checkTo("Orchestrator"), "ready to close", "the last task was just done: the wait is 30 minutes")
	assert.NotContains(t, r.next(), "ready to close", "12 minutes")
	assert.NotContains(t, r.next(), "ready to close", "23 minutes")
	line := fmt.Sprintf("Board: Goal #%d: every task (2) is done", g)
	out := r.next()
	assert.Contains(t, out, line, "34 minutes: past the wait")
	assert.Contains(t, out, "ready to close")
	assert.NotContains(t, out, "off the board's tasks", "a line about the board itself, not an agent's")
	assert.NotContains(t, out, "Secret goal title", "numbers only, never the goal's title")
	assert.NotContains(t, r.next(), "ready to close", "said once")
	// Another task, finished: a new moment, a new line (the clock of the check is already past the wait of the new last task's time).
	r.moreDone(g, 1)
	assert.Contains(t, r.next(), fmt.Sprintf("Goal #%d: every task (3) is done", g), "the goal got another task and finished it: said again")
}

func TestAGoalWithAnOpenTaskOrAClosedGoalIsNotReady(t *testing.T) {
	r := newReadyRig(t)
	ctx := context.Background()
	open := r.goalDone("open", 1)
	_, err := r.s.CreateTaskWithOpts(ctx, "team", "still going", "", "medium", "Operator", &board.CreateTaskOpts{GoalID: &open}, "Dev")
	require.NoError(t, err)
	closed := r.goalDone("closed", 1)
	_, _, err = r.s.CloseGoal(ctx, "team", closed, "met", board.GoalDone)
	require.NoError(t, err)
	for i := 0; i < 4; i++ {
		assert.NotContains(t, r.next(), "ready to close")
	}
}

func TestTheGoalsReadySwitchAndWaitFollowTheSettings(t *testing.T) {
	r := newReadyRig(t)
	r.goalDone("g", 1)
	r.settings(func(hs *board.HealthSettings) { hs.GoalsReady.On = false })
	for i := 0; i < 4; i++ {
		assert.NotContains(t, r.next(), "ready to close", "off means silent")
	}
	r.settings(func(hs *board.HealthSettings) { hs.GoalsReady = board.HealthWaitCheck{On: true, WaitMin: 600} })
	assert.NotContains(t, r.next(), "ready to close", "a 10 hour wait")
	r.settings(func(hs *board.HealthSettings) { hs.GoalsReady.WaitMin = 30 })
	assert.Contains(t, r.next(), "ready to close", "turned on with a short wait: said once")
	assert.NotContains(t, r.next(), "ready to close")
}

func TestOpenTasksWithNoGoalOrNoAssigneeAreNamedByNumberOnceAfterTheWait(t *testing.T) {
	r := newReadyRig(t)
	ids := r.loose(2)
	assert.NotContains(t, r.checkTo("Orchestrator"), "Open tasks with no goal", "just made: the wait is 15 minutes")
	out := r.next()
	assert.NotContains(t, out, "Open tasks with no goal", "11 minutes")
	out = r.next()
	want := fmt.Sprintf("Board: Open tasks with no goal: #%d, #%d; with no assignee: #%d, #%d (each older than 15 min)", ids[0], ids[1], ids[0], ids[1])
	assert.Contains(t, out, want, "22 minutes: past the wait")
	assert.NotContains(t, out, "older than 15 min). Seen", "a line about the board itself, not an agent's (no seen-ago evidence)")
	assert.NotContains(t, r.next(), "Open tasks with no goal", "the same set is said once")
	// A set that changes is said again (the new task is older than the wait on the check's clock at once), a title never.
	more := r.loose(1)
	again := r.next()
	assert.Contains(t, again, fmt.Sprintf("#%d", more[0]))
	assert.Contains(t, again, "Open tasks with no goal")
	assert.NotContains(t, again, "loose")
}

func TestTheUnownedTasksLineNamesAFewAndCountsTheRest(t *testing.T) {
	r := newReadyRig(t)
	r.loose(10)
	r.next()
	out := r.next()
	assert.Equal(t, 2, strings.Count(out, "and 2 more"), "each list names 8 and counts the other 2: %s", out)
}

func TestAnOwnedTaskOrAYoungOneIsNotNamed(t *testing.T) {
	r := newReadyRig(t)
	ctx := context.Background()
	g := r.goalDone("g", 0)
	_, err := r.s.CreateTaskWithOpts(ctx, "team", "owned", "", "medium", "Operator", &board.CreateTaskOpts{GoalID: &g}, "Dev")
	require.NoError(t, err)
	for i := 0; i < 3; i++ {
		assert.NotContains(t, r.next(), "Open tasks with no", "a goal and an assignee")
	}
	r.settings(func(hs *board.HealthSettings) { hs.UnownedTasks.On = false })
	r.loose(1)
	for i := 0; i < 3; i++ {
		assert.NotContains(t, r.next(), "Open tasks with no", "off means silent")
	}
}

func TestTheNamedMemberIsToldOnceThroughTheGate(t *testing.T) {
	r := newReadyRig(t)
	r.settings(func(hs *board.HealthSettings) {
		hs.GoalsReady.Nudge = "Dev"
		hs.UnownedTasks.Nudge = "Dev"
	})
	g := r.goalDone("g", 1)
	r.loose(1)
	for i := 0; i < 4; i++ {
		r.next()
	}
	r.mu.Lock()
	got := append([]string(nil), r.sent["Dev"]...)
	r.mu.Unlock()
	var ready, unowned int
	for _, m := range got {
		if strings.Contains(m, fmt.Sprintf("Goal #%d: every task (1) is done", g)) {
			ready++
		}
		if strings.Contains(m, "Open tasks with no goal") {
			unowned++
		}
	}
	assert.Equal(t, 1, ready, "the goal line, once: %v", got)
	assert.Equal(t, 1, unowned, "the tasks line, once: %v", got)
	for _, m := range got {
		if strings.Contains(m, "ready to close") || strings.Contains(m, "Open tasks") {
			assert.True(t, strings.HasPrefix(m, "[Coral health] "), m)
		}
	}
}

func TestAKeptLineOfTheseChecksIsSilentWhenTheirSwitchIsOff(t *testing.T) {
	r := newReadyRig(t)
	ctx := context.Background()
	require.NoError(t, r.s.AddOffBooks(ctx, "team", board.OffBooksGoalReady, "Board", "7|1|x", "Goal #7: every task (1) is done, the last 40 min ago: ready to close", r.now))
	require.NoError(t, r.s.AddOffBooks(ctx, "team", board.OffBooksUnowned, "Board", "g9|a9", "Open tasks with no goal: #9 (each older than 15 min)", r.now))
	r.settings(func(hs *board.HealthSettings) {
		hs.GoalsReady.On = false
		hs.UnownedTasks.On = false
	})
	out := r.checkTo("Orchestrator")
	assert.NotContains(t, out, "Goal #7", "off in settings means silent, a line already kept included")
	assert.NotContains(t, out, "Open tasks with no goal")
	r.settings(func(hs *board.HealthSettings) {
		hs.GoalsReady.On = true
		hs.UnownedTasks.On = true
	})
	on := r.next()
	assert.Contains(t, on, "Board: Goal #7: every task (1) is done")
	assert.Contains(t, on, "Board: Open tasks with no goal: #9")
	assert.NotContains(t, on, "ready to close. Seen")
	assert.NotContains(t, on, "older than 15 min). Seen")
}

func TestEachCheckNudgesItsOwnMember(t *testing.T) {
	r := newReadyRig(t)
	r.settings(func(hs *board.HealthSettings) { hs.GoalsReady.Nudge = "Dev" }) // the unowned-tasks check has no one to nudge
	r.goalDone("g", 1)
	r.loose(1)
	for i := 0; i < 4; i++ {
		r.next()
	}
	r.mu.Lock()
	got := append([]string(nil), r.sent["Dev"]...)
	r.mu.Unlock()
	var ready, unowned int
	for _, m := range got {
		if strings.Contains(m, "ready to close") {
			ready++
		}
		if strings.Contains(m, "Open tasks with no goal") {
			unowned++
		}
	}
	assert.Equal(t, 1, ready, "%v", got)
	assert.Equal(t, 0, unowned, "the tasks line has no nudge member: %v", got)
}

func TestTheTwoChecksAreOnForATeamThatNeverSetThem(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.settings(func(hs *board.HealthSettings) { hs.On = true }) // the check itself on, nothing else touched: the operator's call is that these two lines come with it
	r := &readyRig{h}
	g := r.goalDone("g", 1)
	loose := r.loose(1)
	var out string
	for i := 0; i < 3; i++ {
		out += r.next()
	}
	assert.Contains(t, out, fmt.Sprintf("Goal #%d: every task (1) is done", g))
	assert.Contains(t, out, fmt.Sprintf("Open tasks with no goal: #%d", loose[0]))
	assert.False(t, h.s.GetHealthSettings(context.Background(), "team").Landing.On, "the landing alert stays off")
}
