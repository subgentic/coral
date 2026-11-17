package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19170 (walk F11): the Orchestrator's opening question to the Operator is closed, with a note naming the goal, by the first goal the board gets. Through the routes: the marking when the question is posted and the
// closing when the goal is made.
func TestTheFirstGoalClosesTheOrchestratorsOpeningQuestionThroughTheRoutes(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, who := range []string{"Lead", "Operator"} {
		_, err := h.bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	r := chi.NewRouter()
	r.Post("/api/board/{project}/messages", h.PostMessage)
	r.Post("/api/board/{project}/goals", func(w http.ResponseWriter, req *http.Request) {
		h.CreateGoal(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie)))
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	post := func(path string, body map[string]any) map[string]any {
		b, _ := json.Marshal(body)
		resp, err := http.Post(srv.URL+path, "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		require.Less(t, resp.StatusCode, 300, "%v", out)
		return out
	}
	idOf := func(m map[string]any) int64 {
		if v, ok := m["id"].(float64); ok {
			return int64(v)
		}
		t.Fatalf("no id in %v", m)
		return 0
	}
	opening := idOf(post("/api/board/team/messages", map[string]any{"subscriber_id": "Lead", "content": "@Operator What should the team build?", "ask": true}))
	other := idOf(post("/api/board/team/messages", map[string]any{"subscriber_id": "Lead", "content": "@Operator Dark mode or light?", "ask": true}))
	closed := func(id int64) (bool, string) {
		m, err := h.bs.GetMessageByID(ctx, "team", id)
		require.NoError(t, err)
		require.NotNil(t, m.Ask)
		return m.Ask.Closed, m.Ask.ClosedNote
	}
	isClosed, _ := closed(opening)
	assert.False(t, isClosed)

	g := post("/api/board/team/goals", map[string]any{"title": "Ship the recipe app", "created_by": "Operator"})
	gid := idOf(g)
	isClosed, note := closed(opening)
	assert.True(t, isClosed, "the first goal closes the opening question")
	assert.Contains(t, note, "Ship the recipe app")
	assert.Contains(t, note, "#"+itoa(gid))
	isClosed, _ = closed(other)
	assert.False(t, isClosed, "a question that was not the opening one stays open")
}
