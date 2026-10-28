package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9779: the health report's open-review lines (#3725) are read from the board status, which reads the open tasks without their workflows
// (#9114); a review the Orchestrator has not delegated sits in review_pending, which is not an open status there either. The lines went quiet on
// both counts and no test noticed, because the one that pins them read every task with ListTasks. This one asks the status route.
func TestBoardStatusHealthReportShowsOpenReviews(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "rev"
	for _, s := range []struct{ id, title string }{{"lead", "Orchestrator"}, {"worker", "Backend Dev"}, {"QA Engineer", "QA Engineer"}} {
		_, err := h.bs.Subscribe(ctx, team, s.id, s.title, s.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	task, err := h.bs.CreateTask(ctx, team, "Build the thing", "", "high", "lead", "worker")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, team, "worker", task.ID)
	require.NoError(t, err)
	_, err = h.bs.SubmitCompletionReviewAtRevisionAndCandidate(ctx, team, task.ID, "worker", "built it", "", "ready", nil, nil, "")
	require.NoError(t, err)
	_, _, err = h.bs.HandToOrchestrator(ctx, team, task.ID, "worker")
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Get("/api/board/{project}/status", h.TeamAvailability)
	report := func() string {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", "/api/board/"+team+"/status", nil))
		require.Equal(t, 200, w.Code, w.Body.String())
		var out struct {
			Report []string `json:"health_report"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		return strings.Join(out.Report, "\n")
	}

	assert.Contains(t, report(), fmt.Sprintf("#%d is in review with lead, not yet completed or delegated", task.ID), "submitted, not yet delegated")

	_, created, err := h.bs.DelegateReview(ctx, team, task.ID, "lead", []string{"QA Engineer"})
	require.NoError(t, err)
	require.Len(t, created, 1)
	lines := report()
	assert.Contains(t, lines, fmt.Sprintf("QA Engineer has review #%d of #%d open (pending", created[0].ID, task.ID), "delegated")
	assert.NotContains(t, lines, "not yet completed or delegated")
}
