package routes

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
)

// SubmitCompletionReview preserves a candidate; it does not complete the task.
func (h *BoardHandler) SubmitCompletionReview(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	id, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	var body struct {
		SubscriberID      string               `json:"subscriber_id"`
		Message           string               `json:"message"`
		Outcome           string               `json:"outcome"`
		Reason            string               `json:"reason"`
		Artifacts         []board.TaskArtifact `json:"artifacts"`
		ExpectedRevision  *int                 `json:"expected_revision,omitempty"`
		CandidateRevision string               `json:"candidate_revision,omitempty"`
		Areas             []string             `json:"areas,omitempty"`     // the review's areas (#8957); absent: from paths when they are listed
		Reviewers         int                  `json:"reviewers,omitempty"` // 1 (the default) or 2
		Paths             []string             `json:"paths,omitempty"`     // the files the change touches, when the caller knows them
	}
	derr := decodeJSON(r, &body)
	if derr == nil {
		attrWho, attrOK := attributedTo(w, r, body.SubscriberID)
		if !attrOK {
			return
		}
		body.SubscriberID = attrWho
	}
	if derr != nil || body.SubscriberID == "" {
		errBadRequest(w, "subscriber_id and valid JSON required")
		return
	}
	areas := body.Areas
	if len(areas) == 0 && len(body.Paths) > 0 {
		areas = reviewAreasFromPaths(body.Paths)
	}
	areas, aerr := board.NormalizeReviewAreas(areas) // refused before anything is recorded
	if aerr != nil {
		errBadRequest(w, strings.TrimPrefix(aerr.Error(), board.ErrReviewArea.Error()+": "))
		return
	}
	if body.Reviewers < 0 || body.Reviewers > board.MaxReviewersWanted {
		errBadRequest(w, fmt.Sprintf("reviewers is 1 or %d", board.MaxReviewersWanted))
		return
	}
	unverified := h.vetTaskArtifacts(r, project, body.Artifacts)
	task, err := h.bs.SubmitCompletionReviewAtRevisionAndCandidate(r.Context(), project, id, body.SubscriberID, body.Message, body.Outcome, body.Reason, body.Artifacts, body.ExpectedRevision, body.CandidateRevision)
	if err != nil {
		if strings.Contains(err.Error(), "revision") {
			errConflict(w, err.Error())
		} else {
			errTaskStore(w, err)
		}
		return
	}
	// #3725: the task goes to the team's orchestrator, who completes or delegates it; the
	// author's slot is free at once. A team with no orchestrator completes it here.
	ctx := r.Context()
	author := body.SubscriberID
	if task.AssignedTo != nil && *task.AssignedTo != "" {
		author = *task.AssignedTo
	}
	orch, reopened, err := h.bs.HandToOrchestrator(ctx, project, id, author)
	if errors.Is(err, board.ErrNoOrchestrator) {
		msg := body.Message
		done, cerr := h.bs.CompleteTaskWithArtifactsAtRevisionAndCandidate(ctx, project, id, author, &msg, body.Outcome, body.Artifacts, body.ExpectedRevision, body.CandidateRevision)
		if cerr != nil {
			errBadRequest(w, cerr.Error())
			return
		}
		h.afterTaskCompleted(project, author, done, msg, "completed without review: no orchestrator on the team")
		writeTaskVetted(w, done, unverified)
		return
	}
	if err != nil {
		errTaskStore(w, err)
		return
	}
	h.stopReminder(project, id)
	candidate := body.CandidateRevision
	if candidate == "" {
		candidate = fmt.Sprintf("%d artifacts", len(body.Artifacts))
	}
	if reopened != nil {
		// Resubmitted after a rejection (#3787): its reviewers review the new revision, with no
		// orchestrator step; the orchestrator is told, and can still change the reviewers.
		// a reviewer at work on their own task is named without an @: no mention, no nudge; the review is offered when their task ends (#8875)
		var mentions []string
		for _, rv := range reopened.Reviewers {
			if h.reviewerBusy(ctx, project, rv.Reviewer, rv.ReviewTaskID) {
				mentions = append(mentions, rv.Reviewer+" (busy: offered when their task ends)")
				continue
			}
			mentions = append(mentions, "@"+rv.Reviewer)
		}
		h.postNotice(ctx, project, fmt.Sprintf("%s [Task #%d resubmitted for review, round %d] %s submitted %q again (candidate: %s; %s). Review it again: coral-board task detail %d, then coral-board task approve %d --round %d, or reject %d --round %d --note \"why\". @%s the same reviewers have it; change them with coral-board task review %d --to \"...\"",
			strings.Join(mentions, " "), id, reopened.Round, h.noticeText(ctx, project, author), h.noticeText(ctx, project, task.Title), h.noticeText(ctx, project, candidate), h.noticeText(ctx, project, body.Reason), id, id, reopened.Round, id, reopened.Round, orch, id))
	} else if h.autoDelegateReview(ctx, project, id, orch) { // #4175: Coral delegates to the named reviewers
	} else if h.putReviewInPool(ctx, project, id, task.Title, author, areas, body.Reviewers, candidate, body.Reason) { // #8957: or the review waits in the board's pool for an agent that only reviews
	} else {
		h.postNotice(ctx, project, fmt.Sprintf("@%s [Task #%d in review] %s submitted %q (candidate: %s; %s). Complete it with 'coral-board task complete %d', or delegate it: coral-board task review %d --to \"Security Reviewer,QA Engineer\"",
			orch, id, h.noticeText(ctx, project, author), h.noticeText(ctx, project, task.Title), h.noticeText(ctx, project, candidate), h.noticeText(ctx, project, body.Reason), id, id))
	}
	h.nudgeNextTask(ctx, project, author)
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	task, _ = h.bs.GetTask(ctx, project, id)
	writeTaskVetted(w, task, unverified)
}

// DelegateReview gives a task in review to reviewers: one review task each, in their queue
// (#3725). Only the team's orchestrator.
// POST /api/board/{project}/tasks/{taskID}/review {subscriber_id, reviewers: ["Security Reviewer", ...]}
func (h *BoardHandler) DelegateReview(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	id, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	var body struct {
		SubscriberID string   `json:"subscriber_id"`
		Reviewers    []string `json:"reviewers"`
	}
	derr := decodeJSON(r, &body)
	if derr == nil {
		attrWho, attrOK := attributedTo(w, r, body.SubscriberID)
		if !attrOK {
			return
		}
		body.SubscriberID = attrWho
	}
	if derr != nil || body.SubscriberID == "" {
		errBadRequest(w, "subscriber_id and valid JSON required")
		return
	}
	ctx := r.Context()
	if err := h.bs.RequireTaskReviewer(ctx, project, body.SubscriberID); err != nil {
		errForbidden(w, err.Error())
		return
	}
	task, reviews, err := h.bs.DelegateReview(ctx, project, id, body.SubscriberID, body.Reviewers)
	if err != nil {
		errTaskGone(w, err)
		return
	}
	names := make([]string, 0, len(reviews))
	for _, rt := range reviews {
		names = append(names, fmt.Sprintf("%s (#%d)", *rt.AssignedTo, rt.ID))
	}
	h.postNotice(ctx, project, fmt.Sprintf("[Task #%d delegated for review by %s] %s", id, h.noticeText(ctx, project, body.SubscriberID), h.noticeText(ctx, project, strings.Join(names, ", "))))
	for _, rt := range reviews {
		h.postNotice(ctx, project, h.buildAssignmentNotification(ctx, project, rt, *rt.AssignedTo, false))
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": task, "reviews": reviews})
}

// ApproveReview / RejectReview record a reviewer's verdict on the review task they claimed
// (#3725). The last approval completes the task (as its orchestrator); a rejection sends it back
// to its author with the note.
// POST /api/board/{project}/tasks/{taskID}/approve {subscriber_id, note}
// POST /api/board/{project}/tasks/{taskID}/reject {subscriber_id, note}
func (h *BoardHandler) ApproveReview(w http.ResponseWriter, r *http.Request) {
	h.reviewVerdict(w, r, true)
}
func (h *BoardHandler) RejectReview(w http.ResponseWriter, r *http.Request) {
	h.reviewVerdict(w, r, false)
}

func (h *BoardHandler) reviewVerdict(w http.ResponseWriter, r *http.Request, approve bool) {
	project := urlParam(r, "project")
	id, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	var body struct {
		SubscriberID string `json:"subscriber_id"`
		Note         string `json:"note"`
		TaskVersion  int    `json:"task_version"`
		Round        int    `json:"round"`    // the round reviewed; an earlier one is refused (#3787)
		Revision     *int   `json:"revision"` // the revision of the round read (patches that joined it, #5689); absent: not stated
	}
	derr := decodeJSON(r, &body)
	if derr == nil {
		attrWho, attrOK := attributedTo(w, r, body.SubscriberID)
		if !attrOK {
			return
		}
		body.SubscriberID = attrWho
	}
	if derr != nil || body.SubscriberID == "" {
		errBadRequest(w, "subscriber_id and valid JSON required")
		return
	}
	ctx := r.Context()
	var v *board.ReviewVerdict
	if approve {
		rev := board.NoRevisionStated
		if body.Revision != nil {
			rev = *body.Revision
		}
		v, err = h.bs.ApproveReviewTextVersion(ctx, project, id, body.SubscriberID, body.Note, body.Round, rev, body.TaskVersion)
	} else {
		v, err = h.bs.RejectReviewTextVersion(ctx, project, id, body.SubscriberID, body.Note, body.Round, body.TaskVersion)
	}
	if err != nil {
		if strings.Contains(err.Error(), "only the reviewers") {
			errForbidden(w, err.Error())
		} else if strings.Contains(err.Error(), "was resubmitted") || strings.Contains(err.Error(), "changed since you read it") {
			errConflict(w, err.Error())
		} else {
			errTaskGone(w, err)
		}
		return
	}
	task := v.Task
	note := ""
	if body.Note != "" {
		note = ": " + h.noticeText(ctx, project, body.Note) // the reviewer's words, quoted: they tag no one
	}
	switch {
	case v.Rejected:
		h.postNotice(ctx, project, fmt.Sprintf("@%s [Task #%d rejected by %s] back to you%s. Fix it and submit-review again: the same reviewers review the new revision", v.Author, task.ID, h.noticeText(ctx, project, body.SubscriberID), note))
		h.postNotice(ctx, project, h.buildAssignmentNotification(ctx, project, task, v.Author, true))
	case v.Complete:
		h.postNotice(ctx, project, fmt.Sprintf("[Task #%d approved by %s] every reviewer approved: completing it%s", task.ID, h.noticeText(ctx, project, body.SubscriberID), note))
		msg := ""
		var done *board.Task
		var cerr error
		if cr := task.Workflow.CompletionReview; cr != nil {
			// the candidate the board kept: its patch revisions stay as they are (#5689)
			msg = cr.Message
			done, cerr = h.bs.CompleteApprovedReview(ctx, project, task.ID, v.Orchestrator, &task.Revision)
		} else {
			done, cerr = h.bs.CompleteTaskWithArtifactsAtRevisionAndCandidate(ctx, project, task.ID, v.Orchestrator, &msg, "success", nil, &task.Revision, "")
		}
		if cerr != nil {
			h.postNotice(ctx, project, fmt.Sprintf("@%s [Task #%d approved, but it could not be completed: %s] complete it with 'coral-board task complete %d'", v.Orchestrator, task.ID, h.noticeText(ctx, project, cerr.Error()), task.ID))
		} else {
			task = done
			h.afterTaskCompleted(project, v.Orchestrator, done, msg, "approved by "+strings.Join(v.Approvers, ", "))
		}
	default:
		h.postNotice(ctx, project, fmt.Sprintf("[Task #%d approved by %s] waiting for the other reviewers%s", task.ID, h.noticeText(ctx, project, body.SubscriberID), note))
	}
	// The reviewer's slot is free: their next task.
	h.nudgeNextTask(ctx, project, body.SubscriberID)
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": task, "review_task": v.ReviewTask, "completed": v.Complete && task.Status == "completed", "rejected": v.Rejected})
}

func (h *BoardHandler) ReleaseCompletionReview(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	id, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	var body struct {
		SubscriberID string `json:"subscriber_id"`
		Reason       string `json:"reason"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	attrWho, attrOK := attributedTo(w, r, body.SubscriberID)
	if !attrOK {
		return
	}
	body.SubscriberID = attrWho
	if err := h.bs.RequireTaskReviewer(r.Context(), project, body.SubscriberID); err != nil {
		errForbidden(w, err.Error())
		return
	}
	task, err := h.bs.ReleaseCompletionReview(r.Context(), project, id, body.SubscriberID, body.Reason)
	if err != nil {
		errTaskGone(w, err)
		return
	}
	h.stopReminder(project, id)
	h.postNotice(r.Context(), project, fmt.Sprintf("[Task #%d pending completion review] %s released the worker slot. No completion outcome was accepted. Reason: %s", id, h.noticeText(r.Context(), project, body.SubscriberID), h.noticeText(r.Context(), project, body.Reason)))
	if task.AssignedTo != nil {
		if next := h.bs.NextPendingTaskForSubscriber(r.Context(), project, *task.AssignedTo); next != nil {
			h.postNotice(r.Context(), project, h.buildAssignmentNotification(r.Context(), project, next, *task.AssignedTo, false))
		}
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	writeJSON(w, http.StatusOK, task)
}
