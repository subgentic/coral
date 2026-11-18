package routes

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19623: releasing a task to the queue is not a broadcast. The line stays on the board, tagged to the Orchestrator alone: no @notify-all
// (that woke every agent), and a receive-all bystander reads nothing of it.
func TestAReleasedTaskIsNotBroadcastToEveryAgent(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title string }{{"Orchestrator", "Orchestrator"}, {"Dev", "Developer"}, {"Other", "Developer"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, "claude-"+s.id, nil, "all")
		require.NoError(t, err)
	}
	task, err := h.bs.CreateTask(ctx, "team", "T1", "", "medium", "Orchestrator", "Dev")
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/board/team/tasks/%d/release", task.ID), bytes.NewReader([]byte(`{"subscriber_id":"Orchestrator"}`)))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", "team")
	rctx.URLParams.Add("taskID", fmt.Sprint(task.ID))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.ReleaseTaskByID(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	h.background.Wait()

	msgs, err := h.bs.ListMessages(ctx, "team", 100, 0, 0)
	require.NoError(t, err)
	var line string
	for _, m := range msgs {
		if strings.Contains(m.Content, "released by") {
			line = m.Content
		}
	}
	require.NotEmpty(t, line, "the board still has the line")
	assert.NotContains(t, line, "@notify-all")
	assert.Contains(t, line, "@Orchestrator")
	for _, who := range []string{"Dev", "Other"} {
		peek, err := h.bs.PeekMessages(ctx, "team", who, 50)
		require.NoError(t, err)
		for _, m := range peek {
			assert.NotContains(t, m.Content, "released by", "%s is not told", who)
		}
	}
}
