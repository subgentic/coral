package routes

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/board"
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
	project := urlParam(r, "project")
	taskID, err := parseID(urlParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	if _, v, ok := h.taskSizeVerdict(w, r, project, taskID); ok {
		if v.Over && v.OverLimit == reviewsize.ModeSplit {
			v.SplitAsk = v.SplitAskFor(taskID)
		}
		writeJSON(w, http.StatusOK, v)
	}
}

// taskSizeVerdict counts a task's changes by the team's guard, for the banner and for Split. It answers the request itself when it cannot (Hub, no setting, no diff) and says so with ok false. A team
// with the guard off gets the empty verdict and no diff is read.
func (h *BoardHandler) taskSizeVerdict(w http.ResponseWriter, r *http.Request, project string, taskID int64) (*board.Task, reviewsize.Verdict, bool) {
	if cloud.Tunneled(r) {
		errForbidden(w, "the review size verdict is not served through Coral Hub")
		return nil, reviewsize.Verdict{}, false
	}
	set, err := h.bs.GetReviewSizeSetting(r.Context(), project)
	if err != nil {
		errInternalServer(w, "the review size guard could not be read")
		return nil, reviewsize.Verdict{}, false
	}
	if !set.On {
		return nil, reviewsize.Verdict{}, true // the default: no diff is read for a team that never turned it on
	}
	task, data, ok := h.taskDiff(w, r, project, taskID)
	if !ok {
		return nil, reviewsize.Verdict{}, false
	}
	who := ""
	if task.CompletedBy != nil {
		who = *task.CompletedBy
	}
	if strings.TrimSpace(who) == "" && task.AssignedTo != nil {
		who = *task.AssignedTo
	}
	return task, set.Verdict(who, reviewsize.ParseDiff(data)), true
}

// SplitReviewSize is Split on the banner (#21059): POST /api/board/{project}/tasks/{taskID}/review-size/split asks the team's Orchestrator to read a change that is over the limit and file follow-up
// tasks under it. The review stays open; nothing is approved or rejected. The Operator or the team's Orchestrator, locally; never through Coral Hub. A change that is not over the limit is a 409.
func (h *BoardHandler) SplitReviewSize(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	taskID, err := parseID(urlParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	if _, ok := h.healthAdmin(r, project); !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can ask for a split")
		return
	}
	_, v, ok := h.taskSizeVerdict(w, r, project, taskID)
	if !ok {
		return
	}
	if !v.Applies || !v.Over {
		errConflict(w, "this change is not over the team's review size limit")
		return
	}
	orch, err := h.bs.TeamOrchestrator(r.Context(), project)
	if err != nil || orch == "" {
		errConflict(w, "the team has no Orchestrator to ask")
		return
	}
	h.postWakingNotice(r.Context(), project, orchestratorTag(orch)+"[Task #"+strconv.FormatInt(taskID, 10)+" review] "+h.noticeText(r.Context(), project, v.SplitAskFor(taskID)))
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "asked": orch})
}

// SendBackReviewSize is Send back on the banner (#21059): POST /api/board/{project}/tasks/{taskID}/review-size/send-back {note} returns a task waiting in review, whose change is over the limit, to its
// author with the note (the one the banner offered, as the person edited it). The Operator or the team's Orchestrator, locally; never through Coral Hub. A change not over the limit is a 409, so the
// button cannot be used to send back anything else. The author is told on the board, and the task is theirs again.
func (h *BoardHandler) SendBackReviewSize(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	taskID, err := parseID(urlParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	who, ok := h.healthAdmin(r, project)
	if !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can send a task back for its size")
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := decodeJSONStrict(r, &body); err != nil {
		errBadRequest(w, "invalid JSON: {\"note\":\"why, and the limit\"}")
		return
	}
	_, v, ok := h.taskSizeVerdict(w, r, project, taskID)
	if !ok {
		return
	}
	if !v.Applies || !v.Over {
		errConflict(w, "this change is not over the team's review size limit")
		return
	}
	note := strings.TrimSpace(body.Note)
	if note == "" {
		note = v.SendBackNote
	}
	task, err := h.bs.SendBackFromReview(r.Context(), project, taskID, who, note)
	if err != nil {
		errTaskGone(w, err)
		return
	}
	author := ""
	if task.AssignedTo != nil {
		author = *task.AssignedTo
	}
	h.postNotice(r.Context(), project, fmt.Sprintf("@%s [Task #%d sent back by %s] %s. Split it and submit-review again: the same reviewers review the new revision (the full note: coral-board task detail %d)", author, taskID, h.noticeText(r.Context(), project, who), h.noticeText(r.Context(), project, oneLine(note, 300)), taskID))
	h.postNotice(r.Context(), project, h.buildAssignmentNotification(r.Context(), project, task, author, true))
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": task})
}
