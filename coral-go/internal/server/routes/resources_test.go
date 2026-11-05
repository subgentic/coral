package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

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
		req = withActor(req, Actor{Kind: ActorToken, Name: as[6:], Session: as[6:]})
	}
	rec := httptest.NewRecorder()
	g.r.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// subscribe joins who to a board; peek is the LAUNCH record's Orchestrator flag (can_peek), which a join never sets. The agent's session is named like the agent.
func (g *resRig) subscribe(project, who, title string, peek bool) {
	g.t.Helper()
	_, err := g.bs.Subscribe(context.Background(), project, who, title, who, nil, "", peek)
	require.NoError(g.t, err)
}

func TestOnlyTheOperatorOrAnOrchestratorDefinesRemovesAndReorders(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Plain Dev", "Developer", false)
	g.subscribe("alpha", "The Orchestrator", "Orchestrator", true)
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

// Security's MUST (#13613): a title or a name is caller-supplied, so an agent that joins a board with no Orchestrator as "Orchestrator", or is named like one, is not one.
func TestAJoinedOrchestratorTitleOrNameIsNotAManager(t *testing.T) {
	g := newResRig(t)
	g.subscribe("lonely", "Self Styled", "Orchestrator", false)
	g.subscribe("lonely", "x-orchestrator", "Developer", false)
	g.subscribe("alpha", "Real One", "Orchestrator", true)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	g.subscribe("alpha", "Waiting Dev", "Developer", false)
	_, c := g.do("token:Waiting Dev", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	g.do("token:Self Styled", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	_, c2 := g.do("token:x-orchestrator", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	id := strconv.Itoa(int(c2["entry"].(map[string]any)["id"].(float64)))
	_ = c
	for _, who := range []string{"token:Self Styled", "token:x-orchestrator"} {
		code, out := g.do(who, "PUT", "/api/resources/other", map[string]any{"slots": 1})
		assert.Equal(t, 403, code, who+" define")
		assert.Equal(t, "manager_only", out["code"])
		code, _ = g.do(who, "POST", "/api/resources/entries/"+id+"/move", map[string]any{"how": "first"})
		assert.Equal(t, 403, code, who+" move")
		code, _ = g.do(who, "DELETE", "/api/resources/entries/"+id, nil)
		assert.Equal(t, 403, code, who+" cancel")
		code, _ = g.do(who, "DELETE", "/api/resources/mac-heavy", nil)
		assert.Equal(t, 403, code, who+" remove")
	}
	code, _ := g.do("token:Real One", "PUT", "/api/resources/other", map[string]any{"slots": 1})
	assert.Equal(t, 200, code, "the session the launch record registered as an Orchestrator is one")
}

func TestResourceNamesNotesAndListsAreClean(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	for _, bad := range []string{"has%20space", "bad%1b%5b31mname", "-leading", "dot%2F..", "caf%C3%A9"} {
		code, _ := g.do("operator", "PUT", "/api/resources/"+bad, map[string]any{"slots": 1})
		assert.Equal(t, 400, code, bad)
	}
	code, _ := g.do("operator", "PUT", "/api/resources/ok-name_1.2", map[string]any{"slots": 1, "allowed": []string{"Dev A", "bad\u001b[31mx"}})
	assert.Equal(t, 200, code)
	long := strings.Repeat("é", 500) + "\u001b[31mred\u0007"
	_, c := g.do("token:Dev A", "POST", "/api/resources/ok-name_1.2/claim", map[string]any{"note": long})
	note := c["entry"].(map[string]any)["note"].(string)
	assert.LessOrEqual(t, len([]rune(note)), 200, "a note is cut")
	assert.NotContains(t, note, "\u001b")
	assert.NotContains(t, note, "\u0007")
}

// Renew and Release look at the lease first, as claim and the reads do: a lease that ran out is over, and cannot be renewed just because the timer has not run yet.
func TestALeaseThatRanOutCannotBeRenewed(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1, "max_lease_seconds": 1})
	code, _ := g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	require.Equal(t, 200, code)
	time.Sleep(1200 * time.Millisecond) // sleep-ok: a one-second lease running out in real time
	code, out := g.do("token:Dev A", "POST", "/api/resources/mac-heavy/renew", map[string]any{})
	assert.Equal(t, 409, code, "%v", out)
	assert.Equal(t, "not_holder", out["code"])
}

// The match list (#13645): set by the Operator or an Orchestrator with the other fields, shown back, refused when it is not words.
func TestDefineTakesAMatchListAndShowsItBack(t *testing.T) {
	g := newResRig(t)
	code, out := g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1, "match": []string{"go test ./...", "node run_cdp_suites.mjs"}})
	assert.Equal(t, 200, code)
	assert.Equal(t, []any{"go test ./...", "node run_cdp_suites.mjs"}, out["match"])
	_, got := g.do("operator", "GET", "/api/resources/mac-heavy", nil)
	assert.Equal(t, []any{"go test ./...", "node run_cdp_suites.mjs"}, got["match"])
	for _, bad := range []any{[]string{`go test "x"`}, []string{"go test $(x)"}, []string{""}} {
		code, _ := g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1, "match": bad})
		assert.Equal(t, 400, code, "%v", bad)
	}
	g.subscribe("alpha", "Plain Dev", "Developer", false)
	code, _ = g.do("token:Plain Dev", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1, "match": []string{"go test"}})
	assert.Equal(t, 403, code, "an agent cannot add patterns: they decide what the hook claims")
}

// #13704: the Queue folder links the agent, the task and its goal: the list answer carries the task's board (ids repeat across boards) and the task's goal, read server-side, one lookup per distinct task and never one per row on the page.
func TestTheListCarriesEachEntrysTaskBoardAndGoal(t *testing.T) {
	g := newResRig(t)
	ctx := context.Background()
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.subscribe("alpha", "Dev B", "Developer", false)
	g.subscribe("beta", "Dev C", "Developer", false)
	goal, err := g.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Resource queue, round 2", Outcome: "x", DoneWhen: "y", CreatedBy: "Dev A"})
	require.NoError(t, err)
	withGoal, err := g.bs.CreateTask(ctx, "alpha", "has a goal", "", "high", "Dev A", "Dev A")
	require.NoError(t, err)
	_, err = g.bs.ClaimTask(ctx, "alpha", "Dev A", withGoal.ID)
	require.NoError(t, err)
	err = g.bs.SetTaskGoal(ctx, "alpha", withGoal.ID, &goal.ID)
	require.NoError(t, err)
	noGoal, err := g.bs.CreateTask(ctx, "alpha", "no goal", "", "high", "Dev B", "Dev B")
	require.NoError(t, err)
	_, err = g.bs.ClaimTask(ctx, "alpha", "Dev B", noGoal.ID)
	require.NoError(t, err)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	g.do("token:Dev C", "POST", "/api/resources/mac-heavy/claim", map[string]any{}) // no task at all

	_, list := g.do("operator", "GET", "/api/resources", nil)
	res := list["resources"].([]any)[0].(map[string]any)
	h := res["holders"].([]any)[0].(map[string]any)
	assert.Equal(t, "alpha", h["project"], "the task's board")
	assert.EqualValues(t, goal.ID, h["goal_id"])
	assert.Equal(t, "Resource queue, round 2", h["goal_title"])
	q := res["queue"].([]any)
	b := q[0].(map[string]any)
	assert.Equal(t, "alpha", b["project"])
	assert.NotContains(t, b, "goal_id", "a task with no goal has none")
	c := q[1].(map[string]any)
	assert.NotContains(t, c, "project", "no task, no board")
	assert.NotContains(t, c, "goal_title")
}
