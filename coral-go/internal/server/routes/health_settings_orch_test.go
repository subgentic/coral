package routes

import (
	"bytes"
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

// #20136: the team's Orchestrator (and the Operator) read and change every health setting through one route, with no grant; anyone else is refused; it is the Operator's form's own save, so a number outside its
// range is refused with what is accepted, a recipient must be a member (never the Operator), and every change is in the board's log.
func TestTheOrchestratorTunesEveryHealthSettingAndNoOneElseDoes(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title, session string }{{"Orchestrator", "Orchestrator", "claude-orch"}, {"Dev", "Developer", "claude-dev"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	call := func(method, body, query string, mod func(*http.Request)) (int, map[string]any) {
		req := httptest.NewRequest(method, "/api/board/team/health/settings"+query, bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		if mod != nil {
			mod(req)
		}
		rec := httptest.NewRecorder()
		if method == http.MethodGet {
			h.GetHealthSettings(rec, req)
		} else {
			h.PutHealthSettings(rec, req)
		}
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	as := func(session string) func(*http.Request) {
		return func(r *http.Request) {
			*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-" + session, SessionName: session}))
		}
	}
	orch, dev := as("claude-orch"), as("claude-dev")

	// Who: the Orchestrator and the Operator; another agent is refused on both verbs; Coral Hub is refused.
	code, _ := call(http.MethodGet, "", "", dev)
	assert.Equal(t, http.StatusForbidden, code, "an agent reads nothing")
	code, _ = call(http.MethodPut, `{"key":"landing.wait_min","value":"240"}`, "", dev)
	assert.Equal(t, http.StatusForbidden, code, "an agent changes nothing")
	code, _ = call(http.MethodPut, `{"key":"landing.wait_min","value":"240"}`, "", func(r *http.Request) { orch(r); r.Header.Set(tunnel.ViaHeader, "1") })
	assert.Equal(t, http.StatusForbidden, code, "never through Coral Hub")
	assert.Equal(t, tunnel.TierNever, tunnel.Classify(http.MethodPut, "/api/board/team/health/settings", ""))
	assert.Equal(t, tunnel.TierNever, tunnel.Classify(http.MethodGet, "/api/board/team/health/settings", ""))

	// Show: every key with its default and what it accepts.
	code, out := call(http.MethodGet, "", "", orch)
	require.Equal(t, http.StatusOK, code)
	keys, _ := out["keys"].([]any)
	require.Greater(t, len(keys), 60, "every setting is listed")

	// A number: set, with the old and new value; the store holds it.
	code, out = call(http.MethodPut, `{"key":"landing.wait_min","value":"240"}`, "", orch)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, 240, h.bs.GetHealthSettings(ctx, "team").Landing.WaitMin)
	ch, _ := out["changed"].([]any)
	require.Len(t, ch, 1)
	assert.Equal(t, "landing.wait_min", ch[0].(map[string]any)["Key"])
	// The new settings that were fixed numbers.
	code, out = call(http.MethodPut, `{"key":"off_books.max_lines","value":"9"}`, "", orch)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, 9, h.bs.GetHealthSettings(ctx, "team").OffBooks.MaxLines)
	// A rule's recipient and its text level.
	code, out = call(http.MethodPut, `{"key":"goal_size.to","value":"Dev"}`, "", orch)
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = call(http.MethodPut, `{"key":"goal_size.text","value":"short"}`, "", orch)
	require.Equal(t, http.StatusOK, code, "%v", out)
	got := h.bs.GetHealthSettings(ctx, "team")
	assert.Equal(t, "Dev", got.GoalSize.To)
	assert.Equal(t, "short", got.GoalSize.Level())

	// Refused, in words: out of range, not a number, an unknown key, a bad level, a non-member, the Operator, a rule that does not read it.
	for body, want := range map[string]string{
		`{"key":"landing.wait_min","value":"5"}`:    "outside",
		`{"key":"goal_size.limit","value":"2"}`:     "not accepted",
		`{"key":"goal_size.limit","value":"many"}`:  "not a whole number",
		`{"key":"nope.x","value":"1"}`:              "not a health setting",
		`{"key":"goal_size.text","value":"loud"}`:   "short, normal or long",
		`{"key":"goal_size.to","value":"Stranger"}`: "not a member",
		`{"key":"goal_size.to","value":"Operator"}`: "never the Operator",
		`{"key":"claim_nudge.to","value":"Dev"}`:    "does not read a recipient yet",
		`{"key":"claim_nudge.text","value":"loud"}`: "short, normal or long",
		`{"health":{"landing":{"wait_minutes":9}}}`: "unknown field",
	} {
		code, out = call(http.MethodPut, body, "", orch)
		assert.Equal(t, http.StatusBadRequest, code, body)
		assert.Contains(t, out["error"], want, body)
	}
	assert.Equal(t, 240, h.bs.GetHealthSettings(ctx, "team").Landing.WaitMin, "a refused change changes nothing")

	// Reset puts a key back to its default; a no-op says nothing changed.
	code, out = call(http.MethodPut, `{"key":"landing.wait_min","reset":true}`, "", orch)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, 120, h.bs.GetHealthSettings(ctx, "team").Landing.WaitMin)
	code, out = call(http.MethodPut, `{"key":"landing.wait_min","reset":true}`, "", orch)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, out["changed"])

	// The log: the changes, with who; text a person typed is "changed", never the text.
	code, out = call(http.MethodPut, `{"key":"landing.branch","value":"release/9"}`, "", orch)
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = call(http.MethodGet, "", "?since=24h", orch)
	require.Equal(t, http.StatusOK, code)
	log, _ := out["log"].([]any)
	require.GreaterOrEqual(t, len(log), 5)
	var sawBranch bool
	for _, e := range log {
		m := e.(map[string]any)
		assert.Equal(t, "Orchestrator", m["actor"])
		if m["field"] == "health.landing.branch" {
			sawBranch = true
			assert.Equal(t, "changed", m["new"])
			assert.Empty(t, m["old"], "the old text is not logged")
		}
	}
	assert.True(t, sawBranch)
	_ = time.Now
}
