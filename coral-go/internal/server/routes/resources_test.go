package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	h := &ResourcesHandler{M: mgr, Board: bs, Stats: &resources.StatsBoard{Run: func(_ context.Context, alias, _ string) (string, error) { // no ssh in a test: a box that answers (#17560)
		if alias == "down" {
			return "", errors.New("timed out")
		}
		return " up 1 day, load average: 4.00, 3.00, 2.00\n---\n8\n---\n/dev/sda1 1 1 52428800 1% /\n---\nMem: 1 1 1 1 1 24000\n", nil
	}}}
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
	if m, ok := body.(map[string]any); ok && method == "PUT" && strings.Count(path, "/") == 3 { // a new resource needs a description (#17560): the tests that are about something else get a plain one
		if _, said := m["description"]; !said {
			m["description"] = "a test box"
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

// #13706: a wait that ended without a turn (the CLI's --timeout) asks to keep its place: it stays in line for a grace and the same claim again is the same place; a plain release still drops it.
func TestAWaitThatTimedOutKeepsItsPlaceAndAPlainReleaseDropsIt(t *testing.T) {
	g := newResRig(t)
	for _, n := range []string{"Dev A", "Dev B", "Dev C"} {
		g.subscribe("alpha", n, "Developer", false)
	}
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	_, b := g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	assert.EqualValues(t, 1, b["place"])
	_, c := g.do("token:Dev C", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	assert.EqualValues(t, 2, c["place"])

	code, _ := g.do("token:Dev B", "POST", "/api/resources/mac-heavy/release", map[string]any{"keep_place": true})
	assert.Equal(t, 200, code)
	_, b = g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	assert.EqualValues(t, 1, b["place"], "the same claim again is the same place, not the back of the line")

	code, _ = g.do("token:Dev C", "POST", "/api/resources/mac-heavy/release", map[string]any{})
	assert.Equal(t, 200, code)
	_, c = g.do("token:Dev C", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	assert.EqualValues(t, 2, c["place"], "a plain release leaves the line: the claim again joins behind")
}

// #14262: a claim of a PLAIN slot resource (not a pool's member) says which machine it is on, in the reply: `heavy run` reads it to decide between the mini over ssh and this Mac, and a reply with no machine
// made it run a mini claim on the Mac. A pool's grant still names its member's machine.
// #20345: a release that cancels a queued place says so, and the wait that queued it (it looks again with the place it was given) is answered "cancelled" instead of being queued again and run later.
func TestReleasingAQueuedPlaceCancelsItAndAWaitStillPollingStops(t *testing.T) {
	g := newResRig(t)
	for _, n := range []string{"Dev A", "Dev B", "Dev C"} {
		g.subscribe("alpha", n, "Developer", false)
	}
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	_, b := g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	bid := b["entry"].(map[string]any)["id"]
	poll := func(who string, id any) (int, map[string]any) {
		return g.do("token:"+who, "POST", "/api/resources/mac-heavy/claim", map[string]any{"poll_entry": id})
	}
	code, _ := poll("Dev B", bid)
	assert.Equal(t, 202, code, "a look while the place is there is the same place")

	code, out := g.do("token:Dev B", "POST", "/api/resources/mac-heavy/release", map[string]any{})
	assert.Equal(t, 200, code)
	assert.Equal(t, true, out["left_line"], "the release says it cancelled a queued place")
	code, out = poll("Dev B", bid)
	assert.Equal(t, 410, code, "the wait that was still polling is told, not queued again")
	assert.Equal(t, "cancelled", out["code"])
	_, st := g.do("token:Dev B", "GET", "/api/resources/mac-heavy", nil)
	assert.Empty(t, st["queue"], "nobody is queued: the cancelled wait did not join the line again")

	// A new claim that names no place is a new claim.
	code, _ = g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	assert.Equal(t, 202, code)

	// A held slot is released as before, and a wait that keeps its place says nothing was cancelled.
	code, out = g.do("token:Dev A", "POST", "/api/resources/mac-heavy/release", map[string]any{})
	assert.Equal(t, 200, code)
	assert.Equal(t, false, out["left_line"], "a held slot is not a queued place")
	_, c := g.do("token:Dev C", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	cid := c["entry"].(map[string]any)["id"]
	_, out = g.do("token:Dev C", "POST", "/api/resources/mac-heavy/release", map[string]any{"keep_place": true})
	assert.Equal(t, false, out["left_line"], "keeping the place is not cancelling it")
	code, _ = poll("Dev C", cid)
	assert.Equal(t, 202, code, "a place kept for a grace is still the wait's own")

	// A kick (the Orchestrator's) ends the wait too.
	g.do("token:Dev B", "POST", "/api/resources/mac-heavy/release", map[string]any{})
	_, b2 := g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	b2id := b2["entry"].(map[string]any)["id"]
	code, _ = g.do("operator", "DELETE", "/api/resources/entries/"+strconv.Itoa(int(b2id.(float64))), nil)
	assert.Equal(t, 200, code)
	code, out = poll("Dev B", b2id)
	assert.Equal(t, 410, code)
	assert.Equal(t, "cancelled", out["code"])
}

func TestAClaimOfAPlainSlotResourceNamesItsOwnMachine(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev", "Developer", false)
	g.subscribe("alpha", "The Orchestrator", "Orchestrator", true)
	for name, machine := range map[string]string{"mini": "mini", "mac-heavy": "mac"} {
		code, _ := g.do("token:The Orchestrator", "PUT", "/api/resources/"+name, map[string]any{"slots": 1, "machine": machine})
		require.Equal(t, 200, code)
	}
	for name, machine := range map[string]string{"mini": "mini", "mac-heavy": "mac"} {
		code, out := g.do("token:Dev", "POST", "/api/resources/"+name+"/claim", map[string]any{})
		require.Equal(t, 200, code, "%v", out)
		entry := out["entry"].(map[string]any)
		assert.Equal(t, machine, entry["machine"], "the grant of %s says where it is", name)
		code, _ = g.do("token:Dev", "POST", "/api/resources/"+name+"/release", map[string]any{})
		require.Equal(t, 200, code)
	}
	// a pool's grant: the member's machine, as before
	code, _ := g.do("token:The Orchestrator", "PUT", "/api/resources/heavy", map[string]any{"members": []string{"mini", "mac-heavy"}})
	require.Equal(t, 200, code)
	code, out := g.do("token:Dev", "POST", "/api/resources/heavy/claim", map[string]any{})
	require.Equal(t, 200, code, "%v", out)
	entry := out["entry"].(map[string]any)
	assert.NotEmpty(t, entry["member"])
	assert.NotEmpty(t, entry["machine"], "a pool's grant names its member's machine")
}

// #17560: a resource carries its own how-to. A new one needs a description; a redefine that leaves it out keeps it; the view carries it and the stats of its machine.
func TestAResourceNeedsADescriptionWhenNewAndKeepsItOnRedefine(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "The Orchestrator", "Orchestrator", true)
	code, out := g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 2, "machine": "epoch", "description": ""})
	assert.Equal(t, 400, code, "a new resource with no description is refused: %v", out)
	assert.Contains(t, out["error"], "description")
	code, out = g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 2, "machine": "epoch", "description": "Linux: Go only.\x1b[31m ssh epoch\nLine 2"})
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "Linux: Go only.[31m ssh epoch\nLine 2", out["description"], "control characters are dropped, a line break stays")
	code, out = g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 3, "machine": "epoch", "description": ""})
	require.Equal(t, 200, code, "a redefine needs none: %v", out)
	assert.Equal(t, "Linux: Go only.[31m ssh epoch\nLine 2", out["description"], "and keeps the stored one")
	long := strings.Repeat("x", 900) + "\n2\n3\n4\n5\n6\n7\n8"
	_, out = g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 3, "machine": "epoch", "description": long})
	assert.LessOrEqual(t, len([]rune(out["description"].(string))), 600, "cut at 600 characters")
	_, out = g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 3, "machine": "epoch", "description": "1\n2\n3\n4\n5\n6\n7\n8"})
	assert.Equal(t, "1\n2\n3\n4\n5\n6", out["description"], "six lines at most")
}

// #17560: the view of a resource carries its machine's stats: read from the machine (a remote one over ssh to its name), "unreachable" when ssh fails, none for a resource that does not say where it is.
func TestAResourceViewCarriesItsMachinesStats(t *testing.T) {
	g := newResRig(t)
	g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 2, "machine": "epoch", "where": "remote"})
	g.do("operator", "PUT", "/api/resources/gone", map[string]any{"slots": 1, "machine": "down", "where": "remote"})
	g.do("operator", "PUT", "/api/resources/nowhere", map[string]any{"slots": 1, "machine": "somewhere"})
	// a first look at a remote box answers "checking" and reads it in the background (#17656): look again until it has answered
	settled := func(name string) map[string]any {
		var out map[string]any
		require.Eventually(t, func() bool {
			_, out = g.do("operator", "GET", "/api/resources/"+name, nil)
			st, _ := out["stats"].(map[string]any)
			return st != nil && st["state"] != "checking"
		}, 5*time.Second, 5*time.Millisecond, "%s: the background read answered", name)
		return out
	}
	out := settled("epoch-go")
	st, _ := out["stats"].(map[string]any)
	require.NotNil(t, st, "%v", out)
	assert.Equal(t, "ok", st["state"])
	assert.EqualValues(t, 8, st["cpu_count"])
	assert.EqualValues(t, 24000, st["mem_available_mb"])
	out = settled("gone")
	assert.Equal(t, "unreachable", out["stats"].(map[string]any)["state"])
	_, out = g.do("operator", "GET", "/api/resources/nowhere", nil)
	assert.Nil(t, out["stats"], "no where, no stats")
}

// A resource states facts and a weight, a pool states needs, and a redefine without them keeps them (#17586).
func TestAResourceCarriesFactsWeightAndNeedsAndRefusesBadOnes(t *testing.T) {
	g := newResRig(t)
	code, out := g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 2, "machine": "epoch", "facts": map[string]string{"os": "linux", "go": "1.26"}, "weight": 16})
	require.Equal(t, 200, code, "%v", out)
	assert.EqualValues(t, 16, out["weight"])
	assert.Equal(t, map[string]any{"os": "linux", "go": "1.26"}, out["facts"])
	code, out = g.do("operator", "PUT", "/api/resources/linux", map[string]any{"members": []string{"epoch-go"}, "needs": []string{"os=linux", "go>=1.26"}})
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, []any{"os=linux", "go>=1.26"}, out["needs"])
	_, out = g.do("operator", "PUT", "/api/resources/epoch-go", map[string]any{"slots": 3, "machine": "epoch"})
	assert.EqualValues(t, 16, out["weight"], "a redefine that leaves them out keeps them")
	assert.Equal(t, "linux", out["facts"].(map[string]any)["os"])
	code, out = g.do("operator", "PUT", "/api/resources/bad", map[string]any{"slots": 1, "facts": map[string]string{"bad key": "x"}})
	assert.Equal(t, 400, code, "%v", out)
	code, _ = g.do("operator", "PUT", "/api/resources/bad2", map[string]any{"members": []string{"epoch-go"}, "needs": []string{"nonsense"}})
	assert.Equal(t, 400, code)
}

// PUT ?check=1 answers whether the caller may define and defines nothing (resource setup asks before it reads a box, #17894).
func TestAskingMayIDefineAnswersForTheCallerAndDefinesNothing(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Plain Dev", "Developer", false)
	g.subscribe("alpha", "The Orchestrator", "Orchestrator", true)
	body := map[string]any{"slots": -1}
	code, out := g.do("token:Plain Dev", "PUT", "/api/resources/newbox?check=1", body)
	assert.Equal(t, 403, code, "an ordinary agent is told no")
	assert.Equal(t, "manager_only", out["code"])
	code, out = g.do("token:The Orchestrator", "PUT", "/api/resources/newbox?check=1", body)
	assert.Equal(t, 200, code, "an Orchestrator is told yes")
	assert.Equal(t, true, out["may_define"])
	code, _ = g.do("operator", "PUT", "/api/resources/newbox?check=1", body)
	assert.Equal(t, 200, code)
	code, _ = g.do("operator", "GET", "/api/resources/newbox", nil)
	assert.Equal(t, 404, code, "asking defined nothing")
}

// #18222: ?check=1 runs the name check a definition gets: a name that would be refused is a 400 before any box is read, and a good one is still a 200.
func TestAskingMayIDefineRefusesABadNameLikeADefinitionWould(t *testing.T) {
	g := newResRig(t)
	body := map[string]any{"slots": -1}
	code, _ := g.do("operator", "PUT", "/api/resources/bad%20name?check=1", body)
	assert.Equal(t, 400, code, "a name with a space is refused")
	code, _ = g.do("operator", "PUT", "/api/resources/-leading?check=1", body)
	assert.Equal(t, 400, code, "a name that starts with a dash is refused")
	code, _ = g.do("operator", "PUT", "/api/resources/good-box.1?check=1", body)
	assert.Equal(t, 200, code, "a good name is told yes")
}
