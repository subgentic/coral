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

	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/internal/store"
)

// #13718: a claim an agent makes by hand belongs to the tool call it is made in: when the call ends the slot goes back, with no release command. The Operator's own claim has no call and keeps its lease.
func TestAnAgentsHandClaimEndsWithItsToolCallAndTheOperatorsDoesNot(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	hook := resources.NewHook(g.mgr, resources.HookOptions{})
	h := &ResourcesHandler{M: g.mgr, Board: g.bs, Hook: hook, ToolCall: func(sid string) string { return "call-" + sid }}
	r := chi.NewRouter()
	r.Post("/api/resources/{name}/claim", h.Claim)
	r.Put("/api/resources/{name}", h.Define)
	r.Get("/api/resources/{name}", h.Get)
	g.r = r
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 2})

	claim := func(withSession bool) int {
		var buf bytes.Buffer
		require.NoError(t, json.NewEncoder(&buf).Encode(map[string]any{"subscriber_id": "Dev A"}))
		req := httptest.NewRequest("POST", "/api/resources/mac-heavy/claim", &buf)
		req.Header.Set("Content-Type", "application/json")
		req = withActor(req, Actor{Kind: ActorToken, Name: "Dev A", Session: "claude-sid-a"})
		if withSession {
			req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-sid-a"}))
		}
		rec := httptest.NewRecorder()
		g.r.ServeHTTP(rec, req)
		return rec.Code
	}
	holders := func() int {
		_, st := g.do("operator", "GET", "/api/resources/mac-heavy", nil)
		return len(st["holders"].([]any))
	}
	assert.Equal(t, http.StatusOK, claim(true))
	assert.Equal(t, 1, holders())
	hook.After("sid-a", "call-sid-a") // the Bash call that made the claim ended
	assert.Equal(t, 0, holders(), "the slot went back with no release")

	assert.Equal(t, http.StatusOK, claim(false)) // no verified session: nothing to bind it to
	hook.After("sid-a", "call-sid-a")
	hook.TurnEnded("sid-a")
	assert.Equal(t, 1, holders(), "a claim with no tool call keeps its lease")
}
