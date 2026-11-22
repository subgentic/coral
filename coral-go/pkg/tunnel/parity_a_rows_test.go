package tunnel

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20257 (coral-hub's ask #256265, Security's rulings of 07:21Z): the class A read routes are owner rows at tier view, one row each, with the query list the handler reads closed (any other key is refused). They are
// the computer OWNER's alone (OwnerRefuse: the machine refuses a grantee, a viewer and the Hub service), and a row is exactly its own path: never a neighbour, never another method.
// Held with #19968 (spendTeamKeys) and NOT here: board/{project}/spend (the four Analytics reads are launch-tier owner rows since coral-hub #261001, with the activity counts). GET /api/goal-links stays the Hub service's own row (hubservice.go).
// 14 more are NOT here because their handler refuses the Hub owner on purpose (see heldForTheirHandler below); a row there would only ever answer 403.
var parityARows = []struct {
	method, pattern string
	query           string // one key the handler reads, passed to prove a listed key is not refused ("" = the route reads none)
}{
	{"GET", "/api/board-seats/foreign", ""},
	{"GET", "/api/board/{project}/goal-requests", ""},
	{"GET", "/api/board/{project}/groups", ""},
	{"GET", "/api/board/{project}/groups/{groupID}/members", ""},
	{"GET", "/api/board/{project}/messages/check", ""},
	{"GET", "/api/board/{project}/peek", ""},
	{"GET", "/api/board/{project}/queue", ""},
	{"GET", "/api/board/{project}/reminder", ""},
	{"GET", "/api/board/{project}/waits", ""},
	{"GET", "/api/board/{project}/waits/poll", ""},
	{"GET", "/api/resources/{name}", ""},
	{"GET", "/api/search-access/log", ""},
	{"GET", "/api/sessions/live/{name}/waiting", ""},
	{"GET", "/api/sessions/live/{sessionID}/agent-candidate", ""},
	{"GET", "/api/sessions/resolve", ""},
	{"GET", "/api/tasks/runs", ""},
	{"GET", "/api/tasks/runs/{runID}", ""},
	{"GET", "/api/teams/detail/{name}/uncommitted", ""},
	{"GET", "/api/waiting-on-agent", ""},
	{"POST", "/api/scheduled/validate-cron", ""},
}

func parityAPath(pattern string) string {
	segs := strings.Split(pattern, "/")
	for i, s := range segs {
		if strings.HasPrefix(s, "{") {
			segs[i] = "x1"
		}
	}
	return strings.Join(segs, "/")
}

func TestTheClassAReadRowsAreOwnerRowsAtViewWithAClosedQuery(t *testing.T) {
	for _, r := range parityARows {
		path := parityAPath(r.pattern)
		name := r.method + " " + r.pattern
		assert.Equal(t, TierView, Classify(r.method, path, ""), name)
		pattern, mode := OwnerRoute(r.method, path)
		assert.Equal(t, r.pattern, pattern, name+": its own row, not a neighbour's")
		assert.Equal(t, OwnerRefuse, mode, name+": the owner's alone")
		assert.Equal(t, TierNever, ClassifyService(r.method, path, ""), name+": not the Hub service's")
		assert.Equal(t, TierNever, Classify(r.method, path, "zz_unknown=1"), name+": a key the handler does not read is refused")
		assert.Equal(t, TierNever, Classify(r.method, path, "zz_unknown=1&"+r.query), name)
		// Not a neighbour: one segment more or less is not this row.
		assert.NotEqual(t, r.pattern, firstPattern(r.method, path+"/x1"), name+": a longer path")
		// The owner row is this one method's alone: a write on the same path (some have their own, older rows) is not made the owner's by it.
		for _, m := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodPost} {
			if m == r.method {
				continue
			}
			if _, mode := OwnerRoute(m, path); mode != OwnerNone {
				t.Errorf("%s: %s of the same path is an owner route", name, m)
			}
		}
	}
}

func firstPattern(method, path string) string {
	p, _ := OwnerRoute(method, path)
	return p
}

// The spend row held with #19968 is still refused, and the goal-links read is still the Hub service's alone.
func TestTheHeldAnalyticsAndSpendRowsAreStillRefusedAndGoalLinksStaysTheServices(t *testing.T) {
	for _, p := range []string{"/api/board/x1/spend"} {
		assert.Equal(t, TierNever, Classify("GET", p, ""), p)
		if _, m := OwnerRoute("GET", p); m != OwnerNone {
			t.Errorf("%s has an owner row", p)
		}
	}
	assert.Equal(t, TierNever, Classify("GET", "/api/goal-links", ""), "no person's tier reaches goal-links")
	assert.NotEqual(t, TierNever, ClassifyService("GET", "/api/goal-links", ""))
}

// heldForTheirHandler are the reads of section A whose handler answers the Hub owner with its own refusal (local_only, not_available_through_hub, search_not_on_hub, operator_only): a row would reach nothing. They stay never
// until Security and the Orchestrator decide to lift that refusal, route by route (the sweep in internal/server shows each answer).
var heldForTheirHandler = []string{
	"/api/board/x1/context-reset-status", "/api/board/x1/cross-team-candidates", "/api/board/x1/cross-team-links", "/api/board/x1/cross-team-state", "/api/board/x1/settings/log",
	"/api/board/x1/relay-targets", "/api/board/x1/search", "/api/chief/checks", "/api/chief/checks/x1", "/api/chief/triggers", "/api/reminders", "/api/reminders/agents", "/api/reminders/x1",
	"/api/sessions/live/x1/loaded-skills",
}

func TestTheReadsWhoseHandlerRefusesTheHubOwnerHaveNoRowYet(t *testing.T) {
	for _, p := range heldForTheirHandler {
		assert.Equal(t, TierNever, Classify("GET", p, ""), p)
		assert.Equal(t, TierNever, ClassifyService("GET", p, ""), p)
		if _, m := OwnerRoute("GET", p); m != OwnerNone {
			t.Errorf("%s has an owner row", p)
		}
	}
}
