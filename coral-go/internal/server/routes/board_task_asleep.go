package routes

import (
	"context"
	"fmt"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// A task given to a member that will not read the board now says so to whoever gave it (#17657, from #17652: a task filed to a sleeping member sat unseen, the only signal came later on a post). It is the sentence a post
// to such a member gets (restSentence, #13189), worded for a task, and the members that are awake: the ones of the same role first, else the least loaded.

// taskAsleepOptionsShown is how many awake members the warning names.
const taskAsleepOptionsShown = 3

// assigneeRestWarning is "" when the assignee will read its task (awake, asleep for being idle, which a delivery wakes, no member, or a lookup that is not there), else why it will not and who is awake.
func (h *BoardHandler) assigneeRestWarning(ctx context.Context, project, assignee string) string {
	assignee = strings.TrimSpace(assignee)
	if h.memberRest == nil || h.bs == nil || assignee == "" || board.IsOperatorName(assignee) {
		return ""
	}
	state := h.memberRest(ctx, project, assignee)
	if state == "" {
		return ""
	}
	s := strings.Replace(restSentence(assignee, state, false), "the message waits", "the task waits", 1)
	loads, err := h.bs.AgentLoads(ctx, project)
	if err != nil {
		return s
	}
	role := ""
	for _, l := range loads {
		if board.SameIdentity(l.Name, assignee) {
			role = l.Role
		}
	}
	var same, other []string
	for _, l := range loads { // AgentLoads is least loaded first
		if !l.Awake || board.SameIdentity(l.Name, assignee) {
			continue
		}
		entry := fmt.Sprintf("%s (%d waiting)", l.Name, l.Waiting)
		if role != "" && strings.EqualFold(l.Role, role) {
			same = append(same, entry)
		} else {
			other = append(other, entry)
		}
	}
	switch {
	case len(same) > 0:
		s += " Awake with the same role: " + joinShown(same) + "."
	case len(other) > 0:
		s += " Awake, least loaded: " + joinShown(other) + "."
	}
	return s
}

func joinShown(entries []string) string {
	if len(entries) > taskAsleepOptionsShown {
		entries = entries[:taskAsleepOptionsShown]
	}
	return strings.Join(entries, ", ")
}

// withWarning is the task as the route answers it, with a "warning" beside it when there is one: the task's own fields stay where they were.
func withWarning(task *board.Task, warning string) any {
	if warning == "" || task == nil {
		return task
	}
	return struct {
		*board.Task
		Warning string `json:"warning"`
	}{task, warning}
}
