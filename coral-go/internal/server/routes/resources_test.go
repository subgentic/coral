package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/resources"
)

// #13613: the resource queue's routes, through a real router: who may claim, who may define and reorder, and what the answers say.

type resRig struct {
	t   *testing.T
	r   http.Handler
	bs  *board.Store
	mgr *resources.Manager
}

func newResRig(t *testing.T) *resRig {
	t.Helper()
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	mgr, err := resources.Open(resources.Options{Priorities: resources.BoardPriorities{Store: bs}, AgeStep: -1})
	require.NoError(t, err)
	h := &ResourcesHandler{M: mgr, Board: bs}
	r := chi.NewRouter()
	r.Get("/api/resources", h.List)
	r.Get("/api/resources/{name}", h.Get)
	r.Post("/api/resources/{name}/claim", h.Claim)
	r.Post("/api/resources/{name}/release", h.Release)
	r.Post("/api/resources/{name}/renew", h.Renew)
	r.Put("/api/resources/{name}", h.Define)
	r.Delete("/api/resources/{name}", h.Remove)
	r.Post("/api/resources/entries/{id}/move", h.Move)
	r.Delete("/api/resources/entries/{id}", h.Cancel)
	return &resRig{t: t, r: r, bs: bs, mgr: mgr}
}

// do sends a request as an actor: "operator", "token:<name>" (an agent), or "" (nobody verified).
func (g *resRig) do(as, method, path string, body any) (int, map[string]any) {
	g.t.Helper()
	var buf bytes.Buffer
	if m, ok := body.(map[string]any); ok && len(as) > 6 && as[:6] == "token:" && method == "POST" {
		if _, named := m["subscriber_id"]; !named {
			m["subscriber_id"] = as[6:] // what coral-board sends: its own name
		}
	}
	if body != nil {
		require.NoError(g.t, json.NewEncoder(&buf).Encode(body))
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	switch {
	case as == "operator":
		req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
	case len(as) > 6 && as[:6] == "token:":
		req = withActor(req, Actor{Kind: ActorToken, Name: as[6:]})
	}
	rec := httptest.NewRecorder()
	g.r.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (g *resRig) subscribe(project, who, title string, _ bool) {
	g.t.Helper()
	_, err := g.bs.Subscribe(context.Background(), project, who, title, "", nil, "")
	require.NoError(g.t, err)
}

func TestOnlyTheOperatorOrAnOrchestratorDefinesRemovesAndReorders(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Plain Dev", "Developer", false)
	g.subscribe("alpha", "The Orchestrator", "Orchestrator", false)
	def := map[string]any{"slots": 1, "machine": "mac"}

	code, out := g.do("token:Plain Dev", "PUT", "/api/resources/mac-heavy", def)
	assert.Equal(t, 403, code, "an ordinary agent cannot define")
	assert.Equal(t, "manager_only", out["code"])
	code, _ = g.do("", "PUT", "/api/resources/mac-heavy", def)
	assert.Equal(t, 403, code, "nobody verified cannot either")

	code, out = g.do("token:The Orchestrator", "PUT", "/api/resources/mac-heavy", def)
	assert.Equal(t, 200, code, "an Orchestrator can")
	assert.EqualValues(t, 1, out["slots"])
	code, _ = g.do("operator", "PUT", "/api/resources/mini", map[string]any{"slots": 2})
	assert.Equal(t, 200, code, "so can the Operator")

	// reordering and kicking are the same people's
	g.do("token:Plain Dev", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	g.subscribe("alpha", "Other Dev", "Developer", false)
	code, c2 := g.do("token:Other Dev", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	require.Equal(t, 202, code, "%v", c2)
	id := int(c2["entry"].(map[string]any)["id"].(float64))
	path := "/api/resources/entries/" + strconv.Itoa(id) + "/move"
	code, _ = g.do("token:Other Dev", "POST", path, map[string]any{"how": "first"})
	assert.Equal(t, 403, code, "an agent cannot reorder the line, even for itself")
	code, _ = g.do("token:The Orchestrator", "POST", path, map[string]any{"how": "first"})
	assert.Equal(t, 200, code)
	code, _ = g.do("token:The Orchestrator", "POST", path, map[string]any{"how": "sideways"})
	assert.Equal(t, 400, code)
	code, _ = g.do("token:Plain Dev", "DELETE", "/api/resources/entries/"+strconv.Itoa(id), nil)
	assert.Equal(t, 403, code)
	code, _ = g.do("token:The Orchestrator", "DELETE", "/api/resources/entries/"+strconv.Itoa(id), nil)
	assert.Equal(t, 200, code)
	code, _ = g.do("token:Plain Dev", "DELETE", "/api/resources/mac-heavy", nil)
	assert.Equal(t, 403, code)
	code, _ = g.do("operator", "DELETE", "/api/resources/mac-heavy", nil)
	assert.Equal(t, 200, code)
	code, _ = g.do("operator", "DELETE", "/api/resources/mac-heavy", nil)
	assert.Equal(t, 404, code)
}

func TestAnAgentClaimsWaitsAndReleasesAndTheLineIsReadable(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.subscribe("alpha", "Dev B", "Developer", false)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})

	code, a := g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{"note": "gate run"})
	assert.Equal(t, 200, code)
	assert.Equal(t, true, a["granted"])
	code, b := g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	assert.Equal(t, 202, code, "queued, not refused")
	assert.EqualValues(t, 1, b["place"])
	code, st := g.do("token:Dev B", "GET", "/api/resources/mac-heavy", nil)
	assert.Equal(t, 200, code)
	holders := st["holders"].([]any)
	require.Len(t, holders, 1)
	assert.Equal(t, "Dev A", holders[0].(map[string]any)["agent"])
	assert.Equal(t, "gate run", holders[0].(map[string]any)["note"])
	assert.Len(t, st["queue"].([]any), 1)

	code, _ = g.do("token:Dev B", "POST", "/api/resources/mac-heavy/renew", map[string]any{})
	assert.Equal(t, 409, code, "a waiting agent holds nothing to renew")
	code, _ = g.do("token:Dev A", "POST", "/api/resources/mac-heavy/renew", map[string]any{})
	assert.Equal(t, 200, code)
	code, _ = g.do("token:Dev A", "POST", "/api/resources/mac-heavy/release", map[string]any{})
	assert.Equal(t, 200, code)
	_, st = g.do("token:Dev B", "GET", "/api/resources/mac-heavy", nil)
	assert.Equal(t, "Dev B", st["holders"].([]any)[0].(map[string]any)["agent"], "the next in line holds it now")
	code, _ = g.do("token:Dev A", "POST", "/api/resources/mac-heavy/release", map[string]any{})
	assert.Equal(t, 409, code)
	code, _ = g.do("token:Dev A", "POST", "/api/resources/nothing/claim", map[string]any{})
	assert.Equal(t, 404, code)
	code, list := g.do("token:Dev A", "GET", "/api/resources", nil)
	assert.Equal(t, 200, code)
	assert.Len(t, list["resources"].([]any), 1)
}

func TestARestrictedResourceRefusesAnAgentNotOnItsList(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.do("operator", "PUT", "/api/resources/secret", map[string]any{"slots": 1, "allowed": []string{"Someone Else"}})
	code, out := g.do("token:Dev A", "POST", "/api/resources/secret/claim", map[string]any{})
	assert.Equal(t, 403, code)
	assert.Equal(t, "not_allowed", out["code"])
}

func TestDefineRefusesBadInput(t *testing.T) {
	g := newResRig(t)
	for _, body := range []map[string]any{{"slots": 0}, {"slots": 101}, {"slots": 1, "max_lease_seconds": -1}, {"slots": 1, "max_lease_seconds": 90000}} {
		code, _ := g.do("operator", "PUT", "/api/resources/x", body)
		assert.Equal(t, 400, code, "%v", body)
	}
	code, _ := g.do("operator", "PUT", "/api/resources/has%20space", map[string]any{"slots": 1})
	assert.Equal(t, 400, code)
}

// Under enforced identity the claimer is the verified caller, never what the body names: naming someone else claims for oneself.
func TestTheClaimerIsTheVerifiedCallerWhenIdentityIsEnforced(t *testing.T) {
	setIdentityActorEnforced(true)
	t.Cleanup(func() { setIdentityActorEnforced(false) })
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.subscribe("alpha", "Dev B", "Developer", false)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	code, out := g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{"subscriber_id": "Dev A"})
	assert.Equal(t, 200, code)
	assert.Equal(t, "Dev B", out["entry"].(map[string]any)["agent"])
	code, _ = g.do("", "POST", "/api/resources/mac-heavy/claim", map[string]any{"subscriber_id": "Dev A"})
	assert.Equal(t, 403, code, "nobody verified claims nothing")
}
