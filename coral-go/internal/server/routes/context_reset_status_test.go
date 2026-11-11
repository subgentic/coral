package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #15066: Team settings reads each agent's last compaction or skip reason from one route: the Operator or the orchestrator only, never through Coral Hub.
func TestContextResetStatusListsEachActiveAgentWithItsLine(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title, session string }{{"Orchestrator", "Orchestrator", "claude-orch"}, {"Dev", "Developer", "claude-dev"}, {"QA", "QA", "claude-qa"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	at := time.Date(2026, 11, 10, 6, 0, 0, 0, time.UTC)
	h.SetContextResetStatus(func(name string) (ContextResetLine, bool) {
		switch name {
		case "claude-dev":
			return ContextResetLine{LastCompactedAt: at, LastTokens: 231000, Text: "typed at 06:00", TextAt: at}, true
		case "claude-qa":
			return ContextResetLine{Text: "skipped: it has unread messages", TextAt: at}, true
		}
		return ContextResetLine{}, false
	})
	get := func(mod func(*http.Request)) (int, map[string][]contextResetAgent) {
		req := httptest.NewRequest(http.MethodGet, "/api/board/team/context-reset-status", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		if mod != nil {
			mod(req)
		}
		rec := httptest.NewRecorder()
		h.GetContextResetStatus(rec, req)
		var out map[string][]contextResetAgent
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	as := func(session string) func(*http.Request) {
		return func(r *http.Request) {
			*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-" + session, SessionName: session}))
		}
	}

	code, out := get(nil) // the Operator
	require.Equal(t, http.StatusOK, code)
	byName := map[string]contextResetAgent{}
	for _, a := range out["agents"] {
		byName[a.SessionName] = a
	}
	require.Len(t, byName, 3)
	assert.Equal(t, contextResetAgent{SessionName: "claude-dev", JobTitle: "Developer", LastCompactedAt: "2026-11-10T06:00:00Z", LastTokens: 231000, Text: "typed at 06:00", TextAt: "2026-11-10T06:00:00Z"}, byName["claude-dev"])
	assert.Equal(t, contextResetAgent{SessionName: "claude-qa", JobTitle: "QA", Text: "skipped: it has unread messages", TextAt: "2026-11-10T06:00:00Z"}, byName["claude-qa"], "a skip with no compaction has no compacted time")
	assert.Equal(t, contextResetAgent{SessionName: "claude-orch", JobTitle: "Orchestrator"}, byName["claude-orch"], "an agent with no line is listed with none")

	code, _ = get(as("claude-orch"))
	assert.Equal(t, http.StatusOK, code, "the orchestrator")
	code, _ = get(as("claude-dev"))
	assert.Equal(t, http.StatusForbidden, code, "an agent")
	code, _ = get(func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, "1") })
	assert.Equal(t, http.StatusForbidden, code, "through Coral Hub")
}
