package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

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
