package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13494 (coral-hub's #169766): agents act on decisions, so two conflicting decisions on one file is the risk. Through a hub (the tunnel, or the self-hosted hub's signed stamp) a file that already has an approve, changes
// or deny decision refuses a DIFFERENT one with 409 already_decided and takes the same one again (200, a replay). This computer's own dashboard is unchanged. Ignore and save are not decisions and are not touched.
type oneDecisionRig struct {
	t   *testing.T
	srv *httptest.Server
	id  string
}

func newOneDecisionRig(t *testing.T) *oneDecisionRig {
	t.Helper()
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	srv, h, coralDir := teamArtifactServer(t)
	_ = srv
	r := chi.NewRouter()
	r.Put("/api/board/{project}/artifacts/{id}/tags", h.SetArtifactTags)
	r.Post("/api/board/{project}/artifacts/{id}/review", func(w http.ResponseWriter, req *http.Request) {
		kind := callerDashCookie
		switch req.Header.Get("X-Test-Caller") {
		case "tunnel":
			kind = callerHub
		case "stamp":
			kind = callerHubOwner
		}
		h.ReviewArtifact(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind)))
	})
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	subscribeSession(t, h, "alpha", "Bob", sessBob)
	id := storeManagedArtifact(t, coralDir, "# the plan "+t.Name(), true, true)
	completeWithArtifactsAs(t, h, "alpha", "Alice", "A work", []board.TaskArtifact{{Name: "plan.md", URI: "coral://artifacts/" + id}})
	rig := &oneDecisionRig{t: t, srv: s, id: id}
	rig.put(`{"tags":["for review"]}`)
	return rig
}

func (g *oneDecisionRig) put(body string) {
	req, err := http.NewRequest(http.MethodPut, g.srv.URL+"/api/board/alpha/artifacts/"+g.id+"/tags", strings.NewReader(body))
	require.NoError(g.t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(g.t, err)
	resp.Body.Close()
	require.Equal(g.t, http.StatusOK, resp.StatusCode)
}

// decide sends a decision as caller ("local", "tunnel" or "stamp") and returns the status and the error code.
func (g *oneDecisionRig) decide(caller, decision string) (int, string) {
	g.t.Helper()
	req, err := http.NewRequest(http.MethodPost, g.srv.URL+"/api/board/alpha/artifacts/"+g.id+"/review", strings.NewReader(`{"decision":"`+decision+`"}`))
	require.NoError(g.t, err)
	req.Header.Set("Content-Type", "application/json")
	if caller != "local" {
		req.Header.Set("X-Test-Caller", caller)
		if caller == "tunnel" {
			for k, v := range ownerHeaders(ownerLabel) {
				req.Header.Set(k, v)
			}
		}
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(g.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	code, _ := out["code"].(string)
	return resp.StatusCode, code
}

func TestAHubRefusesADecisionThatConflictsWithOneAlreadyMade(t *testing.T) {
	for _, caller := range []string{"tunnel", "stamp"} {
		// approve, then deny or changes: refused; approve again: a replay
		g := newOneDecisionRig(t)
		code, _ := g.decide(caller, "approve")
		require.Equal(t, http.StatusOK, code, caller+" approves")
		for _, other := range []string{"deny", "changes"} {
			code, why := g.decide(caller, other)
			assert.Equal(t, http.StatusConflict, code, caller+": "+other+" after approve")
			assert.Equal(t, "already_decided", why, caller+": "+other+" after approve")
		}
		code, _ = g.decide(caller, "approve")
		assert.Equal(t, http.StatusOK, code, caller+": the same decision again is a replay")

		// deny, then approve or changes: refused; deny again: a replay
		g = newOneDecisionRig(t)
		code, _ = g.decide(caller, "deny")
		require.Equal(t, http.StatusOK, code)
		for _, other := range []string{"approve", "changes"} {
			code, why := g.decide(caller, other)
			assert.Equal(t, http.StatusConflict, code, caller+": "+other+" after deny")
			assert.Equal(t, "already_decided", why)
		}
		code, _ = g.decide(caller, "deny")
		assert.Equal(t, http.StatusOK, code)

		// changes, then approve or deny: refused (the old rule let it); changes again is a replay
		g = newOneDecisionRig(t)
		code, _ = g.decide(caller, "changes")
		require.Equal(t, http.StatusOK, code)
		for _, other := range []string{"approve", "deny"} {
			code, why := g.decide(caller, other)
			assert.Equal(t, http.StatusConflict, code, caller+": "+other+" after changes")
			assert.Equal(t, "already_decided", why)
		}
		code, _ = g.decide(caller, "changes")
		assert.Equal(t, http.StatusOK, code)
	}
}

// This computer's own dashboard is as it was: it may still follow changes with an approve, and an approve is final for it (a later deny says not_for_review, as before). A file that nobody decided takes any decision from a hub.
func TestTheLocalDashboardIsUnchangedByTheOneDecisionRule(t *testing.T) {
	g := newOneDecisionRig(t)
	code, _ := g.decide("local", "changes")
	require.Equal(t, http.StatusOK, code)
	code, _ = g.decide("local", "approve")
	assert.Equal(t, http.StatusOK, code, "locally, changes can still be followed by an approve")
	code, why := g.decide("local", "deny")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "not_for_review", why, "locally, a later deny on an approved file is refused as it was")

	g = newOneDecisionRig(t)
	code, _ = g.decide("tunnel", "approve")
	assert.Equal(t, http.StatusOK, code, "a file nobody decided takes a decision through the Hub")
}
