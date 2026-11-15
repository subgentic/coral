package background

import (
	"fmt"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// priorityWaitAfter is how long a High task may sit pending behind its owner's lower-priority work before the check says so (#17648): #17604 (High, blocking a trial) waited an hour while its owner was
// three hours into a Medium one, and nothing surfaced it.
const priorityWaitAfter = 30 * time.Minute

// priorityRank orders the board's priorities; an unknown one ranks as Medium.
func priorityRank(p string) int {
	switch p {
	case "critical":
		return 3
	case "high":
		return 2
	case "low":
		return 0
	}
	return 1
}

func priorityWord(p string) string {
	if p == "critical" {
		return "Critical"
	}
	return "High"
}

// priorityWaitItems names each agent that has a High (or Critical) task waiting while it works on a lower-priority task, both for over priorityWaitAfter. A task counts from its last change (a
// reassignment included), the work in hand from its claim. Numbers and names only; it changes nothing.
func priorityWaitItems(tasks []board.Task, now time.Time) []teamhealth.Item {
	type inHand struct {
		id   int64
		rank int
	}
	hand := map[string]inHand{} // per agent: the oldest lower-priority task it has had in progress for over priorityWaitAfter, with the highest rank among them
	for _, t := range tasks {
		if t.Status != "in_progress" || t.AssignedTo == nil || *t.AssignedTo == "" {
			continue
		}
		since := t.CreatedAt
		if t.ClaimedAt != nil {
			since = *t.ClaimedAt
		}
		at, ok := parseTime(since)
		if !ok || now.Sub(at) <= priorityWaitAfter {
			continue
		}
		if cur, seen := hand[*t.AssignedTo]; !seen || priorityRank(t.Priority) > cur.rank {
			hand[*t.AssignedTo] = inHand{id: t.ID, rank: priorityRank(t.Priority)}
		}
	}
	var items []teamhealth.Item
	for _, t := range tasks {
		if t.Status != "pending" || t.AssignedTo == nil || *t.AssignedTo == "" || priorityRank(t.Priority) < 2 || len(t.BlockedBy) > 0 {
			continue
		}
		cur, busy := hand[*t.AssignedTo]
		if !busy || cur.rank >= priorityRank(t.Priority) {
			continue
		}
		at, ok := parseTime(t.UpdatedAt)
		if !ok {
			at, ok = parseTime(t.CreatedAt)
		}
		if !ok || now.Sub(at) <= priorityWaitAfter {
			continue
		}
		agent := *t.AssignedTo
		items = append(items, teamhealth.Item{Rank: 3, Age: now.Sub(at), Agent: teamhealth.Name(agent),
			Problem: fmt.Sprintf("has %s #%d waiting while working on lower-priority #%d for over 30 min", priorityWord(t.Priority), t.ID, cur.id),
			Suggest: fmt.Sprintf("switch to #%d, or reassign it to an idle member of the same role", t.ID),
			Key:     fmt.Sprintf("priority|%s|%d", agent, t.ID), State: taskNumbers([]int64{cur.id})})
	}
	return items
}
