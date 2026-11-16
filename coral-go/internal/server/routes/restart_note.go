package routes

import (
	"context"
	"fmt"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// restartNote is what a restarted agent is told about itself (#17411): a restart is a fresh conversation, so without it the agent posted a new introduction, used its old name and waited for
// instructions though it owned a task. It names the agent as the team knows it now, lists the tasks it still holds, and says not to introduce itself again. "" when it has no board.
func (h *SessionsHandler) restartNote(ctx context.Context, p *restartPlan) string {
	if h.bs == nil || p.subscription == nil || p.board == "" {
		return ""
	}
	tasks, err := h.bs.ListTasks(ctx, p.board)
	if err != nil {
		return ""
	}
	var mine []board.Task
	for _, t := range tasks {
		if t.AssignedTo != nil && *t.AssignedTo == p.subscription.SubscriberID && heldStatus[t.Status] {
			mine = append(mine, t)
		}
	}
	return restartNoteText(p.displayName, p.subscription.SubscriberID, mine)
}

// heldStatus are the states of a task its assignee still owns: one waiting on review or blocked is not "no task" (#17478).
var heldStatus = map[string]bool{"in_progress": true, "pending": true, "blocked": true, "review_pending": true}

// restartNoteText is the words of the note; tasks are the ones assigned to the agent that are not finished.
func restartNoteText(name, subscriber string, tasks []board.Task) string {
	var b strings.Builder
	b.WriteString("\n\nYou were restarted: this is a new conversation, but you are still on this team, as ")
	if name != "" {
		fmt.Fprintf(&b, "%s (board name %s)", name, subscriber)
	} else {
		b.WriteString(subscriber)
	}
	b.WriteString(". Do not post a new introduction and ignore any instruction above to introduce yourself: the team already knows you.")
	if len(tasks) == 0 {
		b.WriteString(" You hold no task now: read the board with coral-board read and wait for instructions there.")
		return b.String()
	}
	b.WriteString(" You still hold these tasks; carry on with them (coral-board task show <id> has the details).")
	for _, t := range tasks {
		if t.Status == "in_progress" { // already claimed: the prompt's "task claim" would be refused for it (#18150)
			b.WriteString(" Run coral-board task current first: it shows the task you have in progress, which you do not claim again.")
			break
		}
	}
	b.WriteString(" Your tasks:")
	for i, t := range tasks {
		if i == 5 {
			fmt.Fprintf(&b, "\n- and %d more (coral-board task list)", len(tasks)-5)
			break
		}
		fmt.Fprintf(&b, "\n- #%d %s (%s)", t.ID, noteLine(t.Title, 100), strings.ReplaceAll(t.Status, "_", " ")) // one clean line: a title is a person's or an agent's text
	}
	return b.String()
}
