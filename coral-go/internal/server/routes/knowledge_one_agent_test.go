package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #19560: the POST may name ONE agent of the team, {"session_id": ...}; anything else in a body, a query, an agent that is not on the team (unknown, or on another team) is refused, and a refused
// request makes no job (the same answer for unknown and foreign, so it tells nothing about other sessions).
func TestDistillKnowledgeOneAgentRequestRules(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	db, err := storetest.Open(t, t.TempDir()+"/teams.db")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h.SetTeamStore(store.NewTeamStore(db))
	ctx := context.Background()
	team, other := "team-19560", "team-19560-other"
	mine, foreign := "aaaaaaaa-1960-4000-8000-000000000001", "bbbbbbbb-1960-4000-8000-000000000002"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: mine, AgentType: "claude", AgentName: "a", WorkingDir: "/w", BoardName: &team}))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: foreign, AgentType: "claude", AgentName: "b", WorkingDir: "/w", BoardName: &other}))

	post := func(query, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/teams/detail/"+team+"/distill-knowledge"+query, strings.NewReader(body))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("name", team)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rr := httptest.NewRecorder()
		h.DistillKnowledge(rr, req)
		return rr
	}
	clear := func() { knowledgeJobsMu.Lock(); delete(knowledgeJobs, team); knowledgeJobsMu.Unlock() }
	hasJob := func() bool {
		knowledgeJobsMu.Lock()
		defer knowledgeJobsMu.Unlock()
		_, ok := knowledgeJobs[team]
		return ok
	}
	t.Cleanup(clear)
	clear()

	for _, bad := range []string{`{"session_id":"` + mine + `","model":"opus"}`, `{"session_id":""}`, `{"session_id":"a b"}`, `{"session_id":"../x"}`, `{"session_id":"` + strings.Repeat("a", 65) + `"}`, `[1]`, `{"session_id":"` + mine + `"} {"x":1}`, `not json`} {
		assert.Equal(t, http.StatusBadRequest, post("", bad).Code, "body %q is refused", bad)
		assert.False(t, hasJob(), "a refused body makes no job")
	}
	assert.Equal(t, http.StatusBadRequest, post("?session_id="+mine, "").Code, "a query is still refused")
	rr := post("", `{"session_id":"`+foreign+`"}`)
	assert.Equal(t, http.StatusNotFound, rr.Code, "an agent of another team is refused")
	assert.False(t, hasJob(), "and makes no job")
	rr2 := post("", `{"session_id":"cccccccc-1960-4000-8000-00000000dead"}`)
	assert.Equal(t, http.StatusNotFound, rr2.Code, "an unknown session is refused")
	assert.Equal(t, rr.Body.String(), rr2.Body.String(), "with the same answer")
	assert.False(t, hasJob())

	ok := post("", `{"session_id":"`+mine+`"}`)
	assert.Equal(t, http.StatusAccepted, ok.Code, "an agent of the team starts a run: %s", ok.Body.String())
	assert.True(t, hasJob())
	knowledgeJobsMu.Lock()
	first := knowledgeJobs[team]
	knowledgeJobsMu.Unlock()
	again := post("", `{"session_id":"`+mine+`"}`)
	assert.Contains(t, []int{http.StatusOK, http.StatusTooManyRequests}, again.Code, "the team's one-run and once-a-minute rules cover a run of one agent too: a second request starts nothing")
	knowledgeJobsMu.Lock()
	assert.Same(t, first, knowledgeJobs[team], "the job is the same one")
	knowledgeJobsMu.Unlock()
}
