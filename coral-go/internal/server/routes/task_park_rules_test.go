package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// A park is for a wait outside the team (#11660, the Operator's rule): not a reviewer (that is a hand-in for review), a wait on the Operator carries their Inbox question, an agent holds at most two, and
// work that is not for now is released. The Operator or the orchestrator parks; the task's assignee, an orchestrator or the Operator releases.
func TestParkRulesAndRelease(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title, session string }{{"Orchestrator", "Orchestrator", "claude-orch"}, {"Dev", "Developer", "claude-dev"}, {"Dev2", "Developer", "claude-dev2"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	_, err := h.bs.Subscribe(ctx, "team", "Sec", "Security Reviewer", "claude-sec", nil, "all", false)
	require.NoError(t, err)
	yes, areas := true, []string{"go"}
	_, err = h.bs.SetReviewSettings(ctx, "team", "Sec", &yes, &areas)
	require.NoError(t, err)
	mk := func(title string) int64 {
		task, err := h.bs.CreateTask(ctx, "team", title, "", "medium", "Orchestrator", "Dev")
		require.NoError(t, err)
		return task.ID
	}
	t1, t2, t3, t4 := mk("T1"), mk("T2"), mk("T3"), mk("T4")

	call := func(path, method string, id int64, body string, mod func(*http.Request), handler http.HandlerFunc) (int, map[string]any) {
		req := httptest.NewRequest(method, fmt.Sprintf("/api/board/team/tasks/%d/%s", id, path), bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		rctx.URLParams.Add("taskID", fmt.Sprint(id))
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		if mod != nil {
			mod(req)
		}
		rec := httptest.NewRecorder()
		handler(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	park := func(id int64, body string) (int, map[string]any) {
		return call("park", http.MethodPost, id, body, nil, h.ParkTask)
	}
	as := func(session string) func(*http.Request) {
		return func(r *http.Request) {
			*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-" + session, SessionName: session}))
		}
	}

	// A wait on a reviewer is not a park: the words, or a member who reviews, by name.
	for _, reason := range []string{"waiting on review", "waiting for the Reviewer", "QA has it", "waiting on Sec", "Security Reviewer is looking"} {
		b, _ := json.Marshal(map[string]any{"reason": reason})
		code, out := park(t1, string(b))
		assert.Equal(t, http.StatusBadRequest, code, reason)
		assert.Equal(t, "park_reviewer", out["code"], reason)
		assert.Contains(t, fmt.Sprint(out["error"]), "submit-review", reason)
	}

	// A wait on the Operator needs their open question.
	code, out := park(t1, `{"reason":"waiting on the Operator's pick"}`)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "park_needs_ask", out["code"])
	code, out = park(t1, `{"reason":"waiting on the Operator's pick","ask_id":99999}`)
	assert.Equal(t, "park_needs_ask", out["code"], "an id that is no question to the Operator")
	notAsk, err := h.bs.PostMessage(ctx, "team", "Dev", "just a post", nil)
	require.NoError(t, err)
	code, out = park(t1, fmt.Sprintf(`{"reason":"waiting on the Operator's pick","ask_id":%d}`, notAsk.ID))
	assert.Equal(t, "park_needs_ask", out["code"], "a post that is no ask")
	q, err := h.bs.PostMessage(ctx, "team", "Dev", "@Operator which layout?", nil)
	require.NoError(t, err)
	require.NoError(t, h.bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	code, out = park(t1, fmt.Sprintf(`{"reason":"waiting on the Operator's pick","ask_id":%d}`, q.ID))
	require.Equal(t, http.StatusOK, code, "%v", out)

	// Another team's wait needs no ask; the cap is two, and the refusal says what to do.
	code, out = park(t2, `{"reason":"waiting on the billing team's API"}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = park(t3, `{"reason":"waiting on the billing team's other API"}`)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "park_cap", out["code"])
	assert.Contains(t, fmt.Sprint(out["error"]), "release one to the queue or finish one")
	code, _ = park(t2, `{"reason":"waiting on the billing team's API, still"}`)
	assert.Equal(t, http.StatusOK, code, "a task that is parked already keeps working")

	// Release: the assignee, the orchestrator or the Operator; another agent may not. It ends the park and makes room.
	code, _ = call("release", http.MethodPost, t1, `{"subscriber_id":"Dev2"}`, as("claude-dev2"), h.ReleaseTaskByID)
	assert.Equal(t, http.StatusForbidden, code, "not the assignee")
	code, out = call("release", http.MethodPost, t1, `{"subscriber_id":"Dev"}`, as("claude-dev"), h.ReleaseTaskByID)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "pending", out["status"])
	assert.Nil(t, out["assigned_to"], "unassigned by default")
	task, _ := h.bs.GetTask(ctx, "team", t1)
	assert.False(t, task.Parked(time.Now()))
	code, out = call("release", http.MethodPost, t2, `{"keep_assigned":true,"subscriber_id":"Orchestrator"}`, as("claude-orch"), h.ReleaseTaskByID)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "Dev", out["assigned_to"], "kept")
	code, _ = park(t3, `{"reason":"waiting on the billing team's other API"}`)
	assert.Equal(t, http.StatusOK, code, "room after a release")
	code, _ = call("release", http.MethodPost, t4, `{}`, nil, h.ReleaseTaskByID)
	assert.Equal(t, http.StatusBadRequest, code, "no subscriber_id: the Operator's own call names itself in the body")
	_, err = h.bs.CompleteTask(ctx, "team", t4, "Dev", nil)
	require.NoError(t, err)
	code, _ = call("release", http.MethodPost, t4, `{"subscriber_id":"Operator"}`, nil, h.ReleaseTaskByID)
	assert.Equal(t, http.StatusBadRequest, code, "finished work")
}
