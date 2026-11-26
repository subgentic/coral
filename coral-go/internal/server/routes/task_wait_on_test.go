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

	"github.com/subgentic/coral/internal/store"
)

// #21697: the owner (by its own token) marks the task waiting on a team member; a stranger, a
// non-member target and a missing reason are refused; the owner clears it.
func TestTheOwnerSetsAndClearsAWaitOnAMember(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title, session string }{{"Orchestrator", "Orchestrator", "claude-orch"}, {"Dev", "Developer", "claude-dev"}, {"QA", "QA Engineer", "claude-qa"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	task, err := h.bs.CreateTask(ctx, "team", "T1", "", "medium", "Orchestrator", "Dev")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)

	call := func(body, session string) int {
		body = strings.Replace(body, "{", `{"subscriber_id":"`+map[string]string{"claude-dev": "Dev", "claude-qa": "QA"}[session]+`",`, 1)
		req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/board/team/tasks/%d/wait-on", task.ID), bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		rctx.URLParams.Add("taskID", fmt.Sprint(task.ID))
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-" + session, SessionName: session}))
		rec := httptest.NewRecorder()
		h.SetTaskWaitOn(rec, req)
		return rec.Code
	}
	waits := func() int {
		w, err := h.bs.ListTaskWaits(ctx, "team")
		require.NoError(t, err)
		return len(w)
	}

	assert.Equal(t, http.StatusForbidden, call(`{"member":"Orchestrator","reason":"x"}`, "claude-qa"), "a member who is not the owner")
	assert.Equal(t, 0, waits())
	assert.Equal(t, http.StatusBadRequest, call(`{"member":"Orchestrator"}`, "claude-dev"), "a reason is required")
	assert.Equal(t, http.StatusBadRequest, call(`{"member":"Nobody","reason":"x"}`, "claude-dev"), "not a member")
	assert.Equal(t, http.StatusBadRequest, call(`{"member":"QA","condition":"a deploy","reason":"x"}`, "claude-dev"), "exactly one target")
	assert.Equal(t, 0, waits())

	assert.Equal(t, http.StatusOK, call(`{"member":"Orchestrator","reason":"need the API choice"}`, "claude-dev"))
	w, err := h.bs.ListTaskWaits(ctx, "team")
	require.NoError(t, err)
	require.Len(t, w, 1)
	assert.Equal(t, "Orchestrator", w[0].WaitOn.Member)
	assert.Equal(t, "need the API choice", w[0].WaitOn.Reason)
	assert.Equal(t, "Dev", w[0].Owner)

	assert.Equal(t, http.StatusOK, call(`{"clear":true}`, "claude-dev"))
	assert.Equal(t, 0, waits())
}
