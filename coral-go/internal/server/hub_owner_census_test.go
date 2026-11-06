package server

import (
	"net/http"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #13694: what the Hub may stamp as the Operator's own click cannot drift from what the Activity record and the person gates need. Three rules, each a test:
//  1. every route the Activity record writes a row for (activityRoutes, activityByHandler) is on the stamp list, or is named in hubStampNotNeeded with why, so a new Activity route cannot be left to
//     leave no row on a remote computer;
//  2. every entry of the list is a real route, and a request on a concrete path of it is served by THAT route (hubowner.Allowed matches {x} against any one segment, so a fixed-word route of the same shape
//     served by another handler would be admitted by a wider pattern);
//  3. nothing that changes the computer itself (code, settings, the Hub link, updates, skills) and neither image upload is on the list (Security's deny list), and neither is any route the census calls
//     "not an Inbox action".

// hubStampNotNeeded: Activity routes that are deliberately not stamped, with why.
var hubStampNotNeeded = map[string]string{
	"POST /api/board/{project}/goal-images": "a picture is bigger than the stamp's 64 KB body cap and would never be stamped; it stays local-only until a bounded design exists (Security, #13694)",
	"POST /api/system/update/check-hub":     "the Hub owner's update check: it changes the computer itself (its own owner route)",
	"POST /api/system/update/relaunch":      "the Hub owner's relaunch: it changes the computer itself (its own owner route)",
	"PUT /api/settings":                     "this computer's settings (the Dismiss of a banner is local to its dashboard)",
}

// neverStamped is what a stamp must never be made for: it changes code or settings on the computer, or its body is bigger than a stamp covers. Every entry must still be a real route (the test fails a
// stale one), and none may be on the list.
var neverStamped = []string{
	"POST /api/system/update/install", "POST /api/system/update/relaunch-local", "POST /api/system/update/check", "PUT /api/system/update/settings",
	"POST /api/skills", "POST /api/skills/{id}/approve", "POST /api/skills/{id}/reject", "DELETE /api/skills/{id}", "POST /api/sessions/live/{name}/skills",
	"POST /api/cloud/connect", "POST /api/cloud/redeem", "POST /api/cloud/disconnect", "POST /api/cloud/rekey", "PUT /api/cloud/hub-relaunch", "PUT /api/cloud/allow-auto-accept",
	"PUT /api/system/hub-mode", "PUT /api/system/hub-operator", "PUT /api/system/terminal-backend", "POST /api/system/terminal-backend/end-leftover",
	"POST /api/system/auto-wake/dismiss", "POST /api/artifacts/prune",
	"POST /api/sessions/live/{name}/notices/pause", "POST /api/sessions/live/{name}/notices/resume",
	"POST /api/chief/checks", "POST /api/chief/checks/{checkID}/run", "PUT /api/chief/checks/{checkID}", "DELETE /api/chief/checks/{checkID}",
	"POST /api/pinned-folders", "DELETE /api/pinned-folders", "DELETE /api/shared-images/{id}",
	"POST /api/board/remotes", "DELETE /api/board/remotes", "PUT /api/custom-models", "POST /api/hub-auto-accept",
	"POST /api/artifacts/{id}/comment-images", "POST /api/board/{project}/goal-images",
	// the routes that install the stamp's secret and hold the API keys of the computers (Hub mode: served by hubModeRoutes below)
	"POST /api/servers/{id}/owner-secret", "POST /api/servers", "PATCH /api/servers/{id}", "DELETE /api/servers/{id}",
	"POST /api/servers/provision/plan", "POST /api/servers/provision/{plan}/connect", "POST /api/servers/provision/{plan}/run", "POST /api/servers/provision/{plan}/forget-key", "DELETE /api/servers/provision/{plan}",
}

// stampedAnyway: routes that are not an Activity row of their own but are on the list on purpose (tier B, Security's answer on #13694): a person's decision gated like the Activity ones.
var stampedAnyway = map[string]string{
	"POST /api/sessions/live/{name}/model": "the chat box's model and thinking-level switch (#13761, Security): a person's choice on their own agent, person-gated, so it must carry the stamp or it answers 403 through the Hub; it types only a validated value",
	"POST /api/board/{project}/asks/{messageID}/buttons/{buttonID}/settle": "the second half of an ask button's click (claim is the Activity row); person-gated, so it must carry the stamp or it answers 403 through the Hub",
}

var paramRe = regexp.MustCompile(`\{[^}]*\}`)

// routeShape is a route with every parameter made anonymous, the form the stamp list and the router can be compared in.
func routeShape(route string) string { return paramRe.ReplaceAllString(route, "{}") }

func servedRoutes(t *testing.T) (chi.Routes, map[string]string) {
	t.Helper()
	srv, _, _ := strictServer(t, false)
	rt := srv.Router()
	served := map[string]string{} // shape -> the router's own pattern
	walk := func(rt chi.Routes) {
		require.NoError(t, chi.Walk(rt, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			switch method {
			case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
				served[method+" "+routeShape(route)] = method + " " + route
			}
			return nil
		}))
	}
	walk(rt)
	walk(hubModeRouter(t)) // the routes only a computer in Hub mode serves (the servers it holds keys for, provisioning)
	return rt, served
}

// hubModeRouter is a router of a server in Hub mode.
func hubModeRouter(t *testing.T) chi.Routes {
	t.Helper()
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	cfg.HubMode = true
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	return newTestServer(t, cfg, db, stack.backend, stack.terminal).Router()
}

func stampShapes() map[string]string {
	out := map[string]string{}
	for _, r := range hubowner.Routes() {
		out[routeShape(r)] = r
	}
	return out
}

func TestEveryActivityRouteIsStampedOrSaysWhyNot(t *testing.T) {
	stamped := stampShapes()
	var missing []string
	check := func(k string) {
		if _, ok := hubStampNotNeeded[k]; ok {
			return
		}
		if _, ok := stamped[routeShape(k)]; !ok {
			missing = append(missing, k)
		}
	}
	for k := range routes.ActivityRoutes() {
		check(k)
	}
	for k := range activityByHandler {
		check(k)
	}
	sort.Strings(missing)
	require.Empty(t, missing, "an Activity route that is not stamped writes no row on a remote computer reached through the Hub: add it to hubowner's list (a review is needed) or to hubStampNotNeeded with why")
	for k := range hubStampNotNeeded {
		_, inActivity := routes.ActivityRoutes()[k]
		_, byHandler := activityByHandler[k]
		require.True(t, inActivity || byHandler, "%s is in hubStampNotNeeded but is not an Activity route: the entry is stale", k)
		_, on := stamped[routeShape(k)]
		require.False(t, on, "%s is both stamped and in hubStampNotNeeded", k)
	}
}

func TestEveryStampedRouteIsARealRouteThatServesItself(t *testing.T) {
	rt, served := servedRoutes(t)
	for _, entry := range hubowner.Routes() {
		method, pattern, _ := strings.Cut(entry, " ")
		_, ok := served[method+" "+routeShape(pattern)]
		require.True(t, ok, "%s is on the stamp list but no such route is served: a stale entry", entry)
		// a concrete path of the entry: every parameter becomes the same one-segment value
		path := paramRe.ReplaceAllString(pattern, "1")
		rctx := chi.NewRouteContext()
		require.True(t, rt.Match(rctx, method, path), "%s %s is not served", method, path)
		require.Equal(t, routeShape(pattern), routeShape(rctx.RoutePattern()), "%s %s is served by %s, not by the route the stamp list names: a wider pattern would stamp another handler's route", method, path, rctx.RoutePattern())
	}
}

func TestNothingThatChangesTheComputerIsStamped(t *testing.T) {
	_, served := servedRoutes(t)
	stamped := stampShapes()
	for _, k := range neverStamped {
		method, pattern, _ := strings.Cut(k, " ")
		_, real := served[method+" "+routeShape(pattern)]
		require.True(t, real, "%s is in neverStamped but is not a route any more: the entry is stale", k)
		_, on := stamped[routeShape(k)]
		require.False(t, on, "%s must never be stamped (it changes this computer itself, or its body is bigger than a stamp covers)", k)
		require.False(t, hubowner.Allowed(method, paramRe.ReplaceAllString(pattern, "1")), "%s is allowed by the stamp list", k)
	}
	// and no route the Activity census calls "not an Inbox action" is stamped (the original eight are the only ones that were never in a census list)
	for k := range activityNotAnInboxAction {
		if _, hubOwned := hubStampNotNeeded[k]; hubOwned {
			continue
		}
		if _, ok := stampedAnyway[k]; ok {
			continue
		}
		_, on := stamped[routeShape(k)]
		require.False(t, on, "%s is not an Inbox action but is on the stamp list", k)
	}
}

// The other direction (Security's SHOULD on #13694): hubowner.Allowed matches {x} against any one segment, so a wide entry also admits a fixed-word route of the same shape that another handler serves
// (a future DELETE /api/artifacts/prune would be admitted by DELETE /api/artifacts/{id}). For every served mutating route, a concrete path of it (parameters become 1, fixed words stay) is allowed only
// when the route's own shape is on the list.
func TestOnlyListedRoutesAreAdmittedByTheStampList(t *testing.T) {
	_, served := servedRoutes(t)
	stamped := stampShapes()
	for _, route := range served {
		method, pattern, _ := strings.Cut(route, " ")
		if hubowner.Allowed(method, paramRe.ReplaceAllString(pattern, "1")) {
			_, on := stamped[routeShape(route)]
			require.True(t, on, "%s is admitted by a wider pattern of the stamp list without being on it: a stamp would be made for another handler's route", route)
		}
	}
}
