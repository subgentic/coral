package routes

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// maxWaitReason is the longest reason a wait-on may give, in characters.
const maxWaitReason = 300

// SetTaskWaitOn marks a task waiting on a member or a condition, or clears it (#21697): POST /api/board/{project}/tasks/{taskID}/wait-on {"subscriber_id", "member", "condition", "reason", "clear"}. The task's owner, an
// orchestrator or the Operator may set or clear it; the member named must be on the team. It changes no status: the task stays in progress. --blocked-by stays for waits on other tasks.
func (h *BoardHandler) SetTaskWaitOn(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	taskID, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil || taskID <= 0 {
		errBadRequest(w, "invalid task ID")
		return
	}
	var body struct {
		SubscriberID string `json:"subscriber_id"`
		Member       string `json:"member"`
		Condition    string `json:"condition"`
		Reason       string `json:"reason"`
		Clear        bool   `json:"clear"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	who, ok := attributedTo(w, r, body.SubscriberID)
	if !ok {
		return
	}
	cur, err := h.bs.GetTask(r.Context(), project, taskID)
	if err != nil || cur == nil {
		errNotFound(w, "Task not found")
		return
	}
	if !h.requirePlannerOrAssignee(w, r.Context(), project, cur, who, "mark it waiting") {
		return
	}
	if body.Clear {
		task, _, err := h.bs.ClearTaskWaitOn(r.Context(), project, taskID)
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, task)
		return
	}
	member, condition := strings.TrimSpace(body.Member), clitext.Clean(strings.TrimSpace(body.Condition))
	reason := clitext.Clean(strings.TrimSpace(body.Reason))
	switch {
	case (member == "") == (condition == ""):
		errBadRequest(w, "name exactly one of --member and --condition")
		return
	case reason == "":
		errBadRequest(w, "--reason is required: say what you are waiting for")
		return
	case len([]rune(reason)) > maxWaitReason || len([]rune(condition)) > maxWaitReason:
		errBadRequest(w, "the reason and the condition are at most 300 characters each")
		return
	}
	if member != "" {
		subs, err := h.bs.ListSubscribers(r.Context(), project)
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		found := ""
		for _, s := range subs {
			if board.SameIdentity(s.SubscriberID, member) {
				found = s.SubscriberID
				break
			}
		}
		if found == "" {
			errBadRequest(w, member+" is not a member of this team: use --condition for a wait on something else")
			return
		}
		member = found
	}
	task, err := h.bs.SetTaskWaitOn(r.Context(), project, taskID, board.TaskWaitOn{Member: member, Condition: condition, Reason: reason, SetBy: who})
	switch {
	case errors.Is(err, sql.ErrNoRows):
		errNotFound(w, "Task not found")
	case errors.Is(err, board.ErrNotWaitable):
		errBadRequest(w, err.Error())
	case err != nil:
		errInternalServer(w, err.Error())
	default:
		writeJSON(w, http.StatusOK, task)
	}
}
