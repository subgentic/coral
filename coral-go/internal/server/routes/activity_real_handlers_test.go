package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
)

// #13609, the Orchestrator's ask: the Operator's Send and a permission-prompt answer go through their REAL route handlers (PostMessage, AnswerPrompt), and the row is then read the way the Inbox's Activity
// folder reads it: GET /api/activity.
func activityList(t *testing.T, base string) []map[string]any {
	t.Helper()
	resp, err := http.Get(base + "/api/activity")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out struct {
		Actions []map[string]any `json:"actions"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return out.Actions
}

func TestTheOperatorsTypedAnswerThroughTheRealRouteShowsInTheActivityList(t *testing.T) {
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	was := identityActorEnforced()
	setIdentityActorEnforced(true)
	t.Cleanup(func() { setIdentityActorEnforced(was) })
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler { // the dashboard's own request, as the identity layer stamps it
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
			next.ServeHTTP(w, asPerson(req))
		})
	})
	r.Use(ActivityRecorder(bs))
	r.Post("/api/board/{project}/messages", h.PostMessage)
	r.Get("/api/activity", h.ListActivity)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	ctx := context.Background()
	for _, who := range []string{"Lead", "Operator"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator which design do we ship?", nil)
	require.NoError(t, err)
	to, err := bs.AskTargets(ctx, "team", "Lead", q.Content)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
	require.Empty(t, activityList(t, srv.URL))

	body, _ := json.Marshal(map[string]any{"subscriber_id": "Operator", "as": "Operator", "content": "@Lead the second one", "reply_to": q.ID})
	resp, err := http.Post(srv.URL+"/api/board/team/messages", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	rows := activityList(t, srv.URL)
	require.Len(t, rows, 1, "the Send is in the Activity list")
	assert.Equal(t, board.ActAnswer, rows[0]["action"])
	assert.Equal(t, "question", rows[0]["item_kind"])
	assert.Equal(t, "team", rows[0]["team"])
	assert.Equal(t, "local", rows[0]["source"])
	assert.Contains(t, rows[0]["note"], "the second one")
}

func TestAPermissionPromptAnswerThroughTheRealRouteShowsInTheActivityList(t *testing.T) {
	const sid = "00000000-0000-0000-0000-000000013609"
	menu := "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)\n"
	run := func(t *testing.T, event string) ([]map[string]any, int) {
		_, handler, term, ss := setupSessionsTestServer(t)
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "c-act", WorkingDir: "/tmp/test"}))
		term.addSession("c-act", "/tmp/test")
		fastPromptChecks(t)
		term.mu.Lock()
		term.outputs["c-act"] = menu
		term.mu.Unlock()
		term.mu.Lock()
		term.onRaw = func(name string) { // the agent takes the key: its prompt is gone
			term.mu.Lock()
			term.outputs[name] = "● Working on it.\n"
			term.mu.Unlock()
		}
		term.mu.Unlock()
		handler.hints.note(sid, event)
		bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
		require.NoError(t, err)
		t.Cleanup(func() { bs.Close() })
		r := chi.NewRouter()
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { next.ServeHTTP(w, asPerson(req)) })
		})
		r.Use(ActivityRecorder(bs))
		r.Post("/api/sessions/live/{name}/answer-prompt", handler.AnswerPrompt)
		r.Get("/api/activity", NewBoardHandler(bs).ListActivity)
		srv := httptest.NewServer(r)
		t.Cleanup(srv.Close)
		b, _ := json.Marshal(map[string]any{"n": 1, "label": "Yes", "session_id": sid, "agent_type": "claude"})
		resp, err := http.Post(srv.URL+"/api/sessions/live/c-act/answer-prompt", "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		resp.Body.Close()
		return activityList(t, srv.URL), resp.StatusCode
	}
	rows, code := run(t, "stop") // nothing is waiting: the handler refuses, so no click happened
	assert.Equal(t, http.StatusConflict, code)
	assert.Empty(t, rows)
	rows, code = run(t, "permission_request")
	require.Equal(t, http.StatusOK, code)
	require.Len(t, rows, 1, "the answer is in the Activity list")
	assert.Equal(t, board.ActPromptAnswer, rows[0]["action"])
	assert.Equal(t, "agent", rows[0]["item_kind"])
	assert.Equal(t, "c-act", rows[0]["item_id"])
}
