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
const unownedListMax = board.UnownedMaxListDefault

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
		parts = append(parts, "with no goal: "+taskNumbersMax(noGoal, hs.UnownedTasks.MaxList))
	}
	if len(noAssignee) > 0 {
		parts = append(parts, "with no assignee: "+taskNumbersMax(noAssignee, hs.UnownedTasks.MaxList))
	}
	detail := fmt.Sprintf(hs.UnownedTasks.Pick("Open tasks %s (older than %s)", "Open tasks %s (each older than %s)", "Open tasks %s (each older than %s): give each a goal and an assignee, or close it"), strings.Join(parts, "; "), teamhealth.Age(wait))
	ref := "g" + joinIDs(noGoal) + "|a" + joinIDs(noAssignee)
	if added, err := m.store.AddOffBooksOnce(ctx, project, board.OffBooksUnowned, "Board", ref, detail, now); err == nil && added {
		m.nudgeMember(ctx, project, orch, hs, hs.UnownedTasks.Member(hs.UnownedTasks.Nudge), "unowned-tasks:", detail, bySession, subs)
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
func taskNumbers(ids []int64) string { return taskNumbersMax(ids, unownedListMax) }

// taskNumbersMax is taskNumbers naming at most max numbers (the team's unowned_tasks.max_list).
func taskNumbersMax(ids []int64, max int) string {
	shown := ids
	if len(shown) > max {
		shown = shown[:max]
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
