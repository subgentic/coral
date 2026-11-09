package routes

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// The assignment limit (#14862, the Operator's request): giving a task to an agent that already has more than the team's limit of waiting (pending) tasks is refused with the other agents by load, and force overrides it
// and is recorded on the board. Review tasks are counted as waiting but are not refused by this (task review --to does not ask), and a task an agent makes for itself is its own plan, not an assignment to it.

// assignOptionsShown is how many less loaded agents the refusal names.
const assignOptionsShown = 5

// assignLimitRefusal is what a refused assignment answers.
type assignLimitRefusal struct {
	Error   string            `json:"error"`
	Code    string            `json:"code"`
	Waiting int               `json:"waiting"`
	Limit   int               `json:"limit"`
	Options []board.AgentLoad `json:"options"`
}

// assignOverLimit is the number of waiting tasks of assignee when it is past the team's limit, and the other agents by load; 0 when the assignment is fine (no assignee, the limit off, assigned already, within the limit).
func (h *BoardHandler) assignOverLimit(r *http.Request, project, assignee, taskAssignedTo string) (waiting, limit int, options []board.AgentLoad) {
	assignee = strings.TrimSpace(assignee)
	if assignee == "" || board.SameIdentity(assignee, taskAssignedTo) {
		return 0, 0, nil
	}
	limit = h.bs.GetHealthSettings(r.Context(), project).AssignLimit
	if limit <= 0 {
		return 0, 0, nil
	}
	loads, err := h.bs.AgentLoads(r.Context(), project)
	if err != nil {
		return 0, 0, nil // a count that cannot be read never blocks an assignment
	}
	found := false
	for _, l := range loads {
		if board.SameIdentity(l.Name, assignee) {
			waiting, found = l.Waiting, true
			continue
		}
		options = append(options, l)
	}
	if !found || waiting <= limit {
		return 0, limit, nil
	}
	if len(options) > assignOptionsShown {
		options = options[:assignOptionsShown]
	}
	return waiting, limit, options
}

// refuseOverloaded answers 409 assignee_overloaded and says so when the assignment is past the limit and not forced; it reports whether it did. A forced assignment past the limit returns its waiting count in forced
// for the caller to record once the task exists.
func (h *BoardHandler) refuseOverloaded(w http.ResponseWriter, r *http.Request, project, assignee, taskAssignedTo string, force bool) (refused bool, forced int) {
	waiting, limit, options := h.assignOverLimit(r, project, assignee, taskAssignedTo)
	if waiting == 0 {
		return false, 0
	}
	if force {
		return false, waiting
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s has %d waiting (the limit is %d).", strings.TrimSpace(assignee), waiting, limit)
	if len(options) > 0 {
		b.WriteString(" Less loaded:")
		for i, o := range options {
			state := "asleep"
			if o.Awake {
				state = "awake"
			}
			role := ""
			if o.Role != "" && !strings.EqualFold(o.Role, o.Name) {
				role = ", " + o.Role
			}
			if i > 0 {
				b.WriteString(";")
			}
			fmt.Fprintf(&b, " %s (%d waiting, %s%s)", o.Name, o.Waiting, state, role)
		}
		b.WriteString(".")
	}
	b.WriteString(" Assign it anyway with --force.")
	writeJSON(w, http.StatusConflict, assignLimitRefusal{Error: b.String(), Code: "assignee_overloaded", Waiting: waiting, Limit: limit, Options: options})
	return true, 0
}

// noteForcedAssignment records on the board, against the task's number, who assigned it past the limit and how loaded the agent was.
func (h *BoardHandler) noteForcedAssignment(r *http.Request, project string, taskID int64, assignee, by string, waiting int) {
	if waiting == 0 {
		return
	}
	h.postNotice(r.Context(), project, fmt.Sprintf("[Task #%d assigned to %s past the limit (%d waiting) by %s with --force]", taskID, h.noticeText(r.Context(), project, assignee), waiting, h.noticeText(r.Context(), project, by)))
}
