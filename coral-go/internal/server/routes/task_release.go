package routes

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
)

// ReleaseTaskByID puts "not now" work back in the queue instead of parking it (#11660): POST /api/board/{project}/tasks/{taskID}/release {"keep_assigned": bool}. The task goes to pending with its claim and any park
// cleared, and is unassigned unless keep_assigned (its owner keeps it and claims it again when ready). The task's assignee, an orchestrator or the Operator may release it; unassigned, it is announced to the team.
func (h *BoardHandler) ReleaseTaskByID(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	taskID, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil || taskID <= 0 {
		errBadRequest(w, "invalid task ID")
		return
	}
	var body struct {
		SubscriberID string `json:"subscriber_id"`
		KeepAssigned bool   `json:"keep_assigned"`
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
	if !h.requirePlannerOrAssignee(w, r.Context(), project, cur, who, "release it") {
		return
	}
	task, err := h.bs.ReleaseTask(r.Context(), project, taskID, body.KeepAssigned)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		errNotFound(w, "Task not found")
		return
	case errors.Is(err, board.ErrNotReleasable):
		errBadRequest(w, err.Error())
		return
	case err != nil:
		errInternalServer(w, err.Error())
		return
	}
	if !body.KeepAssigned {
		h.goBG(func() {
			ctx := context.Background()
			h.postNotice(ctx, project, fmt.Sprintf("@notify-all [Task #%d released by %s; now unassigned] %s — run 'coral-board task claim' to pick it up", task.ID, h.noticeText(ctx, project, who), h.noticeText(ctx, project, task.Title)))
		})
	}
	writeJSON(w, http.StatusOK, task)
}
