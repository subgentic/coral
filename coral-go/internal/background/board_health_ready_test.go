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

// #20128: the Needs you "Goal looks done" row says it, and the 15-minute notice to the driver; the health check no longer says "ready to close" a third time, whatever the settings (an old saved goals_ready.on is still read and does nothing).
func TestAGoalWhoseTasksAreAllDoneIsNotALineOfTheCheck(t *testing.T) {
	r := newReadyRig(t)
	r.goalDone("Secret goal title", 2)
	for i := 0; i < 6; i++ {
		assert.NotContains(t, r.next(), "ready to close", "well past the wait of 30 minutes, the check stays silent about a goal that looks done")
	}
	assert.NotContains(t, r.checkTo("Orchestrator"), "every task (2) is done")
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
	r.settings(func(hs *board.HealthSettings) { hs.UnownedTasks.Nudge = "Dev" })
	r.loose(1)
	for i := 0; i < 4; i++ {
		r.next()
	}
	r.mu.Lock()
	got := append([]string(nil), r.sent["Dev"]...)
	r.mu.Unlock()
	var unowned int
	for _, m := range got {
		if strings.Contains(m, "Open tasks with no goal") {
			unowned++
		}
	}
	assert.Equal(t, 1, unowned, "the tasks line, once: %v", got)
	for _, m := range got {
		if strings.Contains(m, "Open tasks") {
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
	assert.NotContains(t, on, "Goal #7", "a goals-ready line kept from an earlier version is never said again (#20128)")
	assert.Contains(t, on, "Board: Open tasks with no goal: #9")
	assert.NotContains(t, on, "ready to close. Seen")
	assert.NotContains(t, on, "older than 15 min). Seen")
}

func TestTheTwoChecksAreOnForATeamThatNeverSetThem(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.settings(func(hs *board.HealthSettings) { hs.On = true }) // the check itself on, nothing else touched: the operator's call is that these two lines come with it
	r := &readyRig{h}
	loose := r.loose(1)
	var out string
	for i := 0; i < 3; i++ {
		out += r.next()
	}
	assert.Contains(t, out, fmt.Sprintf("Open tasks with no goal: #%d", loose[0]))
	assert.False(t, h.s.GetHealthSettings(context.Background(), "team").Landing.On, "the landing alert stays off")
}

// outsideGoals is the check without its GOALS segment (#11412), which names each open goal with its cleaned title: what the other lines say about a goal is still numbers only.
func outsideGoals(check string) string {
	var keep []string
	for _, l := range strings.Split(check, " \u2022 ") {
		if !strings.HasPrefix(l, "Goals: ") {
			keep = append(keep, l)
		}
	}
	return strings.Join(keep, " \u2022 ")
}
