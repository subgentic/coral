package routes

import (
	"context"
	"fmt"
	"time"

	"github.com/subgentic/coral/internal/store"
)

// SaveTaskReminder is how a task's reminder (task add --remind-at, #4175) goes out on the reminders machinery (#19350): it saves a one-time
// reminder for the agent, due in the next minute and marked origin "task", so the Operator's off switch holds it, a restart catches it up and
// 'coral-board remind list' shows it. The task's own rules (open, not parked, once, the board's limits) are checked by the caller.
func SaveTaskReminder(ctx context.Context, sched *store.ScheduleStore, boardName, sessionID string, taskID int64, text string, now time.Time) error {
	at := now.UTC().Add(time.Minute).Truncate(time.Minute)
	_, err := sched.SaveChiefCheck(ctx, store.ChiefCheck{
		Name: fmt.Sprintf("Task #%d", taskID), Instruction: text, TargetBoard: boardName, TargetSession: sessionID, NotifyMode: "every_time",
		ScheduleKind: "once", At: at.Format("2006-01-02T15:04"), Timezone: "UTC", Enabled: true, Origin: "task", CreatedBy: fmt.Sprintf("task #%d", taskID),
	})
	return err
}
