package background

import (
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// priorityWaitAfter is how long a High task may sit pending behind its owner's lower-priority work before the check says so (#17648): #17604 (High, blocking a trial) waited an hour while its owner was
// three hours into a Medium one, and nothing surfaced it.
const priorityWaitAfter = 30 * time.Minute

// priorityWaitItems names each agent that has a High (or Critical) task waiting while it works on a lower-priority task, both for over priorityWaitAfter. Numbers and names only; it changes nothing.
func priorityWaitItems(tasks []board.Task, now time.Time) []teamhealth.Item {
	return nil
}
