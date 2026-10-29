package routes

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// The review pool's routes (#8957, Goal #80): an agent's "Reviews only" setting and areas, and what submit-review does with the areas and the number of reviewers it is asked for.

// SetReviewSettings changes an agent's "Reviews only" switch and the areas it reviews. Only the Operator: an agent that could mark itself as a reviewer could take other agents' reviews and approve them,
// which the orchestrator decided until now. Keys that are absent stay as they are.
// PUT /api/board/{project}/subscribers/{subscriberID}/review-settings  {"reviews_only": true, "review_areas": ["ui","go"]}
func (h *BoardHandler) SetReviewSettings(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	project := urlParam(r, "project")
	who := urlParam(r, "subscriberID")
	var body struct {
		ReviewsOnly *bool     `json:"reviews_only"`
		ReviewAreas *[]string `json:"review_areas"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	if body.ReviewsOnly == nil && body.ReviewAreas == nil {
		errBadRequest(w, "send reviews_only, review_areas or both")
		return
	}
	res, err := h.bs.SetReviewSettings(r.Context(), project, who, body.ReviewsOnly, body.ReviewAreas)
	switch {
	case errors.Is(err, board.ErrNotOnBoard):
		errNotFound(w, err.Error())
	case errors.Is(err, board.ErrReviewArea):
		errBadRequest(w, strings.TrimPrefix(err.Error(), board.ErrReviewArea.Error()+": "))
	case err != nil:
		errInternalServer(w, "could not change the review settings")
	default:
		writeJSON(w, http.StatusOK, res)
	}
}

// reviewAreasFromPaths is the areas a change touches, from the paths it changes (the defaults of submit-review when the author names none and the request lists the paths): go for Go code and
// modules, ui for the dashboard's files, docs for documentation, release for the build and release machinery, security for the code that guards credentials, identity and the network edge. The words are
// a vocabulary, not a rule: the author or the orchestrator can set others.
func reviewAreasFromPaths(paths []string) []string {
	set := map[string]bool{}
	for _, p := range paths {
		p = strings.ToLower(strings.TrimPrefix(path.Clean(strings.ReplaceAll(p, "\\", "/")), "./"))
		ext := path.Ext(p)
		switch {
		case ext == ".go" || strings.HasSuffix(p, "go.mod") || strings.HasSuffix(p, "go.sum"):
			set["go"] = true
		}
		switch {
		case strings.Contains(p, "pkg/frontend/") || ext == ".css" || ext == ".html" || ext == ".js" || ext == ".mjs" || strings.HasPrefix(p, "tests/frontend/"):
			set["ui"] = true
		case ext == ".md" || strings.HasPrefix(p, "docs/") || strings.Contains(p, "agent_docs/") || strings.Contains(p, "site_docs/"):
			set["docs"] = true
		}
		if strings.HasPrefix(p, ".github/") || strings.HasPrefix(p, "installers/") || strings.HasPrefix(p, "tools/devops/") || strings.Contains(p, "release") || strings.HasSuffix(p, ".wxs") {
			set["release"] = true
		}
		for _, hot := range []string{"auth", "secret", "redact", "tunnel", "crypto", "identity", "safefs", "cliauth", "token"} {
			if strings.Contains(p, hot) {
				set["security"] = true
				break
			}
		}
	}
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	sort.Strings(out)
	if len(out) > board.MaxReviewAreas {
		out = out[:board.MaxReviewAreas]
	}
	return out
}

// putReviewInPool puts the review of the task just submitted in the board's pool when the board has an agent that only reviews, and tells the agents it may fit; it says whether it did. The
// orchestrator still holds the task and can name reviewers with task review.
func (h *BoardHandler) putReviewInPool(ctx context.Context, project string, id int64, title, author string, areas []string, wanted int, candidate, reason string) bool {
	pooled, err := h.bs.PutReviewInPool(ctx, project, id, areas, wanted)
	if err != nil || !pooled {
		return false
	}
	task, err := h.bs.GetTask(ctx, project, id)
	if err != nil || task == nil {
		return true
	}
	areaText := "any reviewer"
	if len(task.Workflow.ReviewAreas) > 0 {
		areaText = "areas: " + strings.Join(task.Workflow.ReviewAreas, ", ")
	}
	count := "one reviewer"
	if task.Workflow.ReviewersWanted == 2 {
		count = "two reviewers"
	}
	var fits []string
	subs, _ := h.bs.ListSubscribers(ctx, project)
	for _, sub := range subs {
		if sub.IsActive != 0 && sub.ReviewsOnly && !strings.EqualFold(sub.SubscriberID, author) && board.AreasMatch(sub.ReviewAreas.Slice(), task.Workflow.ReviewAreas) {
			fits = append(fits, sub.SubscriberID)
		}
	}
	mentions := make([]string, len(fits))
	for i, f := range fits {
		mentions[i] = "@" + f
	}
	line := fmt.Sprintf("[Task #%d in the review pool] %s submitted %s (candidate: %s; %s). It waits for %s (%s). A reviewer that matches claims it with 'coral-board task claim', then reads it with 'coral-board task detail %d'.",
		id, h.noticeText(ctx, project, author), quoteNotice(h.noticeText(ctx, project, title)), h.noticeText(ctx, project, candidate), h.noticeText(ctx, project, reason), count, areaText, id)
	if len(mentions) > 0 {
		line = strings.Join(mentions, " ") + " " + line
	} else {
		line += " No reviewer on this board covers those areas yet: the orchestrator can name one with 'coral-board task review " + fmt.Sprint(id) + " --to \"...\"'."
	}
	h.postNotice(ctx, project, line)
	for _, f := range fits {
		if busy, err := h.bs.HasActiveTaskForAssignee(ctx, project, f, 0); err == nil && !busy {
			h.sendTaskNudge(ctx, project, f, reviewPoolNudge)
		}
	}
	return true
}
