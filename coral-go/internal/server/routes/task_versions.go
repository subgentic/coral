package routes

import (
	"context"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// TaskHistory exposes only versions of the task on this board.
func (h *BoardHandler) TaskHistory(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	rows, err := h.bs.TaskHistory(r.Context(), urlParam(r, "project"), id)
	if err != nil {
		errNotFound(w, "task not found")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}
func (h *BoardHandler) requireTaskTextEditor(w http.ResponseWriter, r *http.Request, project string, t *board.Task, actor string) bool {
	if actor == "" {
		errBadRequest(w, "subscriber_id required")
		return false
	}
	if callerActor(r).IsOperator() {
		return true
	}
	if actor == "Operator" {
		return h.requireTaskPlanner(w, r, project, actor)
	}
	if h.isTaskPlanner(r.Context(), project, actor) {
		return true
	}
	errForbidden(w, "only Operator or an active registered orchestrator may change its title or priority, or restore task text")
	return false
}
func (h *BoardHandler) announceTaskTextEdit(ctx context.Context, project, editor string, before, task *board.Task) {
	rows, err := h.bs.TaskHistory(ctx, project, task.ID)
	if err != nil || len(rows) == 0 {
		return
	}
	var v *board.TaskVersion
	for i := range rows {
		if rows[i].Version == task.Version {
			v = &rows[i]
			break
		}
	}
	if v == nil {
		return
	} // a delayed announcement must describe its own version, never a newer edit
	keys := make([]string, 0, len(v.Changes))
	for k := range v.Changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		d := v.Changes[k]
		parts = append(parts, fmt.Sprintf("%s %q → %q", k, d.Before, d.After))
	}
	// Bounded diffs keep a long body/title from exceeding a board message limit.
	diff := taskNoticeText(strings.Join(parts, "; "))
	if len([]rune(diff)) > 3000 {
		diff = string([]rune(diff)[:3000]) + "… (full diff: task history)"
	}
	targets := map[string]bool{}
	if who := taskAssignee(task); who != "" {
		targets[who] = true
	}
	{
		if task.Workflow.OriginalAuthor != "" {
			targets[task.Workflow.OriginalAuthor] = true
		}
		n := len(task.Workflow.ReviewRounds)
		if task.Status == "review_pending" && n > 0 {
			for _, me := range task.Workflow.ReviewRounds[n-1].Reviewers {
				targets[me.Reviewer] = true
			}
		}
	}
	mentions := []string{}
	for who := range targets {
		mentions = append(mentions, "@"+who)
	}
	sort.Strings(mentions)
	h.bs.PostSystemMessage(ctx, project, "Coral Task Queue", fmt.Sprintf("%s Task #%d edited to v%d by %s: %s. Read coral-board task detail %d; older-version approvals do not complete this task.", strings.Join(mentions, " "), task.ID, v.Version, editor, diff, task.ID), nil)
}
func (h *BoardHandler) taskVersionRead(w http.ResponseWriter, r *http.Request, id int64) bool {
	raw := r.URL.Query().Get("version")
	if raw == "" {
		return false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		errBadRequest(w, "version must be positive")
		return true
	}
	rows, err := h.bs.TaskHistory(r.Context(), urlParam(r, "project"), id)
	if err == nil {
		for _, v := range rows {
			if v.Version == n {
				writeJSON(w, http.StatusOK, v)
				return true
			}
		}
	}
	errNotFound(w, "task version not found")
	return true
}

// Task text is quoted data, not an invitation to notify its embedded @names.
func taskNoticeText(text string) string { return strings.ReplaceAll(text, "@", "(at)") }
