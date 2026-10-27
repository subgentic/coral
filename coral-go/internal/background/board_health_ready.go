package background

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// Two more lines of the orchestrator's check (#8975, goal #80), each a switch with its wait: a goal whose every task has been done for the wait is ready to close, and open tasks with no goal
// or no assignee after the wait are named by number. Both read the board's own tables only. The lines are numbers: never a goal's or a task's title (an agent wrote it).

// unownedListMax is how many task numbers one line names before it says how many more there are.
const unownedListMax = 8

// noteGoalsReady records, once per goal and per last-done moment, that the goal is ready to close. A goal that gets another task and finishes it again is a new occurrence.
func (m *BoardHealthMonitor) noteGoalsReady(ctx context.Context, project, orch string, hs board.HealthSettings, bySession map[string]AgentInfo, subs []board.Subscriber, now time.Time) {
	wait := time.Duration(hs.GoalsReady.WaitMin) * time.Minute
	ready, err := m.store.GoalsReadyToClose(ctx, project, now.Add(-wait))
	if err != nil {
		return
	}
	for _, g := range ready {
		detail := fmt.Sprintf("Goal #%d: every task (%d) is done, the last %s ago: ready to close", g.ID, g.Tasks, teamhealth.Age(now.Sub(g.Done)))
		ref := fmt.Sprintf("%d|%d|%s", g.ID, g.Tasks, g.Done.UTC().Format(time.RFC3339)) // the task count too: a task finished in the same second as the last is still a new occurrence
		if added, err := m.store.AddOffBooksOnce(ctx, project, board.OffBooksGoalReady, "Board", ref, detail, now); err == nil && added {
			m.nudgeMember(ctx, project, orch, hs, hs.GoalsReady.Nudge, "goals-ready:", detail, bySession, subs)
		}
	}
}

// noteUnownedTasks records, once per set of tasks, the open tasks that have no goal or no assignee after the wait: one line naming them by number. A set that changes (a task added, or one
// given a goal) is a new occurrence; the same set is said once.
func (m *BoardHealthMonitor) noteUnownedTasks(ctx context.Context, project, orch string, hs board.HealthSettings, bySession map[string]AgentInfo, subs []board.Subscriber, now time.Time) {
	wait := time.Duration(hs.UnownedTasks.WaitMin) * time.Minute
	tasks, err := m.store.UnownedOpenTasks(ctx, project, now.Add(-wait))
	if err != nil || len(tasks) == 0 {
		return
	}
	var noGoal, noAssignee []int64
	for _, t := range tasks {
		if t.NoGoal {
			noGoal = append(noGoal, t.ID)
		}
		if t.NoAssignee {
			noAssignee = append(noAssignee, t.ID)
		}
	}
	var parts []string
	if len(noGoal) > 0 {
		parts = append(parts, "with no goal: "+taskNumbers(noGoal))
	}
	if len(noAssignee) > 0 {
		parts = append(parts, "with no assignee: "+taskNumbers(noAssignee))
	}
	detail := fmt.Sprintf("Open tasks %s (each older than %s)", strings.Join(parts, "; "), teamhealth.Age(wait))
	ref := "g" + joinIDs(noGoal) + "|a" + joinIDs(noAssignee)
	if added, err := m.store.AddOffBooksOnce(ctx, project, board.OffBooksUnowned, "Board", ref, detail, now); err == nil && added {
		m.nudgeMember(ctx, project, orch, hs, hs.UnownedTasks.Nudge, "unowned-tasks:", detail, bySession, subs)
	}
}

func joinIDs(ids []int64) string {
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = strconv.FormatInt(id, 10)
	}
	return strings.Join(s, ",")
}

// taskNumbers is "#12, #15" for the first unownedListMax numbers, then "and N more".
func taskNumbers(ids []int64) string {
	shown := ids
	if len(shown) > unownedListMax {
		shown = shown[:unownedListMax]
	}
	parts := make([]string, len(shown))
	for i, id := range shown {
		parts[i] = "#" + strconv.FormatInt(id, 10)
	}
	out := strings.Join(parts, ", ")
	if more := len(ids) - len(shown); more > 0 {
		out += fmt.Sprintf(" and %d more", more)
	}
	return out
}
