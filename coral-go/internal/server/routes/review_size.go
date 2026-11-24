package routes

import (
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/reviewsize"
)

// GetReviewSizeSetting returns the team's review size guard (#21022): GET /api/board/{project}/review-size. The team's Orchestrator or the Operator, locally; never through Coral Hub.
func (h *BoardHandler) GetReviewSizeSetting(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	if _, ok := h.healthAdmin(r, project); !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can read the review size guard")
		return
	}
	set, err := h.bs.GetReviewSizeSetting(r.Context(), project)
	if err != nil {
		errInternalServer(w, "the review size guard could not be read")
		return
	}
	writeJSON(w, http.StatusOK, set)
}

// PutReviewSizeSetting saves it: PUT /api/board/{project}/review-size with the whole setting (on, lines, files, skip, only_roles, roles). A value out of range is refused with what is accepted; nothing is saved then.
func (h *BoardHandler) PutReviewSizeSetting(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	if h.bs.StaysDeleted(r.Context(), project) {
		writeError(w, http.StatusNotFound, "board_deleted", "this board was deleted")
		return
	}
	if _, ok := h.healthAdmin(r, project); !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can change the review size guard")
		return
	}
	var in reviewsize.Setting
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, "invalid JSON: the whole setting, for example {\"on\":true,\"lines\":800,\"files\":20,\"skip\":[\"*.lock\"]}")
		return
	}
	saved, err := h.bs.SetReviewSizeSetting(r.Context(), project, in)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// TaskReviewSize is what a review's banner is made from (#21022): GET /api/board/{project}/tasks/{taskID}/review-size. It counts the task's own changes.diff by the team's guard for the task's author
// (who completed it, else its assignee) and answers {applies, over, lines, files, skipped_lines, skipped_files, limit_lines, limit_files}. A warning only: nothing here blocks a review. A team with the guard off,
// or a role it does not cover, gets applies false. Local only, never through Coral Hub; a task with no diff is a 404, as its changes.diff is.
func (h *BoardHandler) TaskReviewSize(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		errForbidden(w, "the review size verdict is not served through Coral Hub")
		return
	}
	project := urlParam(r, "project")
	taskID, err := parseID(urlParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	set, err := h.bs.GetReviewSizeSetting(r.Context(), project)
	if err != nil {
		errInternalServer(w, "the review size guard could not be read")
		return
	}
	if !set.On {
		writeJSON(w, http.StatusOK, reviewsize.Verdict{}) // the default: no diff is read for a team that never turned it on
		return
	}
	task, data, ok := h.taskDiff(w, r, project, taskID)
	if !ok {
		return
	}
	who := ""
	if task.CompletedBy != nil {
		who = *task.CompletedBy
	}
	if strings.TrimSpace(who) == "" && task.AssignedTo != nil {
		who = *task.AssignedTo
	}
	writeJSON(w, http.StatusOK, set.Verdict(who, reviewsize.ParseDiff(data)))
}
