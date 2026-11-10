package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12869: a task waiting in review (given to the orchestrator): reassign is a 409 that says what moves it, never a 500, and naming a reviewer already on the round answers "no change" instead of an empty success.
func TestReassigningATaskInReviewAnswers409AndAReviewerAlreadyNamedAnswersNoChange(t *testing.T) {
	srv, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"QA", "QA Engineer"}} {
		_, err := h.bs.Subscribe(ctx, "team", who.id, who.title, who.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	task, err := h.bs.CreateTask(ctx, "team", "Work", "b", "high", "lead", "Dev")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = h.bs.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, "Dev", "built", "", "ready", nil, nil, "")
	require.NoError(t, err)
	_, _, err = h.bs.HandToOrchestrator(ctx, "team", task.ID, "Dev")
	require.NoError(t, err)
	base := srv.URL + "/api/board/team/tasks/" + strconv.FormatInt(task.ID, 10)

	resp := postJSON(t, base+"/reassign", map[string]any{"subscriber_id": "lead", "assignee": "Dev"})
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	resp.Body.Close()
	assert.Equal(t, http.StatusConflict, resp.StatusCode, "a task in review is not reassigned: a 409 with the reason, not a 500: %v", out)
	assert.Contains(t, out["error"], "coral-board task review")

	first := postJSON(t, base+"/review", map[string]any{"subscriber_id": "lead", "reviewers": []string{"QA"}})
	var created map[string]any
	require.NoError(t, json.NewDecoder(first.Body).Decode(&created))
	first.Body.Close()
	require.Equal(t, http.StatusOK, first.StatusCode, created)
	assert.Len(t, created["reviews"], 1)
	assert.NotContains(t, created, "note")

	again := postJSON(t, base+"/review", map[string]any{"subscriber_id": "lead", "reviewers": []string{"QA"}})
	var same map[string]any
	require.NoError(t, json.NewDecoder(again.Body).Decode(&same))
	again.Body.Close()
	require.Equal(t, http.StatusOK, again.StatusCode, same)
	assert.Empty(t, same["reviews"])
	assert.Contains(t, same["note"], "no change: QA already on the review of task #", "an empty success said nothing: it now says no review task was created")
	h.WaitBackground()
}

// #14866 (the Operator): a review task is reassigned to another reviewer through the same route. 200 with the review task now the new reviewer's; the old reviewer is told in a post that it moved; the
// parent's round follows; the author, a reviewer already on the round and a finished review are 409 with the reason.
func TestReassigningAReviewTaskMovesItAndTellsTheOldReviewer(t *testing.T) {
	srv, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, who := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"Dev", "Backend Dev"}, {"QA", "QA Engineer"}, {"Sec", "Security Reviewer"}, {"Rev3", "Tech Lead"}} {
		_, err := h.bs.Subscribe(ctx, "team", who.id, who.title, who.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	task, err := h.bs.CreateTask(ctx, "team", "Work", "b", "high", "lead", "Dev")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = h.bs.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, "Dev", "built", "", "ready", nil, nil, "")
	require.NoError(t, err)
	_, _, err = h.bs.HandToOrchestrator(ctx, "team", task.ID, "Dev")
	require.NoError(t, err)
	_, reviews, err := h.bs.DelegateReview(ctx, "team", task.ID, "lead", []string{"QA", "Sec"})
	require.NoError(t, err)
	qaReview := strconv.FormatInt(reviews[0].ID, 10)
	url := srv.URL + "/api/board/team/tasks/" + qaReview + "/reassign"

	for name, to := range map[string]string{"the author": "Dev", "a reviewer already on it": "Sec"} {
		resp := postJSON(t, url, map[string]any{"subscriber_id": "lead", "assignee": to})
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		resp.Body.Close()
		assert.Equal(t, http.StatusConflict, resp.StatusCode, "%s: %v", name, out)
		assert.NotContains(t, out["error"], "a review task cannot be reassigned", name)
	}

	resp := postJSON(t, url, map[string]any{"subscriber_id": "lead", "assignee": "Rev3"})
	var moved map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&moved))
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode, moved)
	assert.Equal(t, "Rev3", moved["assigned_to"])

	got, err := h.bs.GetTask(ctx, "team", reviews[0].ID)
	require.NoError(t, err)
	require.NotNil(t, got.AssignedTo)
	assert.Equal(t, "Rev3", *got.AssignedTo)
	parent, err := h.bs.GetTask(ctx, "team", task.ID)
	require.NoError(t, err)
	rs := parent.Workflow.ReviewRounds
	var names []string
	for _, r := range rs[len(rs)-1].Reviewers {
		names = append(names, r.Reviewer)
	}
	assert.ElementsMatch(t, []string{"Rev3", "Sec"}, names)
	assert.Eventually(t, func() bool {
		msgs, _ := h.bs.ListMessages(ctx, "team", 50, 0, 0)
		for _, m := range msgs {
			if strings.Contains(m.Content, "@QA Review task #"+qaReview) && strings.Contains(m.Content, "moved to Rev3") {
				return true
			}
		}
		return false
	}, 3*time.Second, 50*time.Millisecond, "the old reviewer is told it moved")
}
