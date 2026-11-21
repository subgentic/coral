package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/pkg/tunnel"
)

const pairGolden = "testdata/pair_census.golden"

// pairProven are the tunnel-reachable writes whose record carries the (link, Hub person) pair, each proven end to end by a test through the real connector and the real router (the test
// named beside it). Everything else a Hub can reach with a write is "pending": the pair is stamped on the request and reaches the handler's context (cloud.ViaFrom), but that handler's
// record does not store it yet. Security's terms (#20312): this list is checked in; a route that is in neither state fails; the pending list may shrink freely and a growing one needs
// Security's review (the golden's diff shows it); it must be empty before any slice that lets a second link be added.
var pairProven = map[string]string{
	"POST /api/board/{project}/cross-team/enable":        "TestV146CrossTeamRoutesThroughTheRealConnectorAndTheRealRouter",
	"POST /api/board/{project}/cross-team/disable":       "TestV146CrossTeamRoutesThroughTheRealConnectorAndTheRealRouter",
	"POST /api/board/{project}/cross-team/files/enable":  "TestV146CrossTeamRoutesThroughTheRealConnectorAndTheRealRouter",
	"POST /api/board/{project}/cross-team/files/disable": "TestV146CrossTeamRoutesThroughTheRealConnectorAndTheRealRouter",
}

func init() {
	// The routes routes.RecordPairWrites records (#20369): each is proven by TestPairRecordedRoutesRecordThePairThroughTheRealConnector.
	for route := range pairRecordedRoutes {
		pairProven[route] = "TestPairRecordedRoutesRecordThePairThroughTheRealConnector"
	}
	for route := range pairUpgradeRoutes {
		pairProven[route] = "TestPairUpgradeRoutesRecordThePairAtConnectAndClose"
	}
}

func TestEveryTunnelWriteRouteRecordsThePairOrIsListedPending(t *testing.T) {
	var lines []string
	registered := map[string]bool{}
	for _, rt := range registeredRoutes(t) {
		method, route, _ := strings.Cut(rt, " ")
		registered[method+" "+route] = true
		upgrade := method == "GET" && strings.HasPrefix(route, "/ws/") // a WebSocket upgrade is a GET that can carry input (#20405): listed like a write
		if (method == "GET" && !upgrade) || method == "HEAD" || method == "OPTIONS" || (!strings.HasPrefix(route, "/api/") && !strings.HasPrefix(route, "/ws/")) {
			continue
		}
		if tunnel.Classify(method, concrete(route), "") == tunnel.TierNever {
			continue // the Hub cannot reach it
		}
		state := "pending"
		if _, ok := pairProven[method+" "+route]; ok {
			state = "recorded"
		}
		lines = append(lines, method+" "+route+" "+state)
	}
	for k, proof := range pairProven {
		require.True(t, registered[k], "%s is listed as proven but is not a route", k)
		require.NotEmpty(t, proof, "%s is listed as recorded with no proof", k)
	}
	got := strings.Join(lines, "\n") + "\n"
	if os.Getenv("PAIR_GOLDEN_UPDATE") == "1" {
		require.NoError(t, os.WriteFile(pairGolden, []byte(got), 0o644))
	}
	want, err := os.ReadFile(pairGolden)
	require.NoError(t, err)
	require.Equal(t, string(want), got, "the Hub-reachable write routes changed: a new one is pending until its record carries the pair; review the diff, then PAIR_GOLDEN_UPDATE=1 go test -tags 'dev fts5' ./internal/server -run TheEveryTunnelWriteRoute")
}

// Every route in pairRecordedRoutes, called through the real connector as the Hub's owner, leaves exactly one Operator-actions row with the route's pattern, the link the connector stamped and the
// person the stream named, whatever the handler answered (a refused write is recorded too). A local call leaves none, and the row never holds the request's body or query (#20369).
func TestPairRecordedRoutesRecordThePairThroughTheRealConnector(t *testing.T) {
	g := newInteg(t)
	ctx := context.Background()
	was := routes.RefusedRowsPerMinute
	routes.RefusedRowsPerMinute = 1 << 20 // each route is called once and most answer with a refusal: the cap has its own test below
	t.Cleanup(func() { routes.RefusedRowsPerMinute = was })
	count := func() []board.HubOperatorAction {
		acts, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
		require.NoError(t, err)
		return acts
	}
	for route := range pairRecordedRoutes {
		method, pattern, _ := strings.Cut(route, " ")
		before := len(count())
		path := pairConcretePath(pattern)
		code, body := g.hub("owner", integOwner, method, path, `{"secret":"SENTINEL"}`, nil)
		acts := count()
		rows := acts[:len(acts)-before]
		var mine []board.HubOperatorAction
		for _, a := range rows {
			if a.Method == method && (a.Path == pattern || a.Path == path) { // the wrapper writes the pattern; a handler that records itself writes the path it was called on
				mine = append(mine, a)
			}
		}
		require.Len(t, mine, 1, "%s: one row for one tunneled write (answered %d %s; rows added: %+v)", route, code, body, rows)
		if mine[0].Path == pattern {
			assert.Equal(t, board.HubActionKindWrite, mine[0].Kind, route+": the wrapper's rows are their own kind")
		}
		assert.Equal(t, testLinkID, mine[0].ViaLink, route)
		assert.Equal(t, integOwner, mine[0].ViaHubUser, route)
		assert.Equal(t, code, mine[0].Status, route)
		assert.NotContains(t, mine[0].Path+mine[0].Project+mine[0].HubUser, "SENTINEL", route)
	}
	// a local call has no pair and is not recorded here
	before := len(count())
	req, err := http.NewRequest("POST", g.local.URL+"/api/hub-auto-accept", strings.NewReader("{}"))
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, before, len(count()), "a local write leaves no pair row")
}

// A WebSocket upgrade carries terminal input and agent control after the handshake (#20405): each route in pairUpgradeRoutes, opened through the real connector by the Hub's owner, leaves a WS-OPEN row at
// connect and a WS-CLOSE row at close, each with the pattern, the link and the person, and nothing from the request (path, query, frames).
func TestPairUpgradeRoutesRecordThePairAtConnectAndClose(t *testing.T) {
	g := newInteg(t)
	ctx := tunnel.WithHubRole(tunnel.WithHubUser(context.Background(), integOwner), "owner")
	rowsFor := func(pattern string) (open, closed []board.HubOperatorAction) {
		acts, err := g.srv.boardStore.RecentHubOperatorActions(context.Background(), 1000)
		require.NoError(t, err)
		for _, a := range acts {
			if a.Path != pattern {
				continue
			}
			switch a.Method {
			case routes.PairWSOpen:
				open = append(open, a)
			case routes.PairWSClose:
				closed = append(closed, a)
			}
		}
		return
	}
	for route := range pairUpgradeRoutes {
		_, pattern, _ := strings.Cut(route, " ")
		conn, err := g.sess.DialWS(ctx, pairConcretePath(pattern), "", nil)
		if err == nil {
			open, _ := rowsFor(pattern)
			require.Len(t, open, 1, "%s: a row at connect, while the stream is open", route)
			conn.CloseNow()
		}
		require.Eventually(t, func() bool { o, c := rowsFor(pattern); return len(o) == 1 && len(c) == 1 }, 5*time.Second, 20*time.Millisecond, "%s: a row at connect and one at close (dial error: %v)", route, err)
		open, closed := rowsFor(pattern)
		for _, a := range append(open, closed...) {
			assert.Equal(t, testLinkID, a.ViaLink, route)
			assert.Equal(t, integOwner, a.ViaHubUser, route)
			assert.Equal(t, board.HubActionKindWrite, a.Kind, route)
			assert.NotContains(t, a.Path+a.Project+a.HubUser, "SENTINEL", route)
		}
	}
	// a path that matches no route is never silent either
	_, err := g.sess.DialWS(ctx, "/ws/nosuch/SENTINEL", "", nil)
	require.Error(t, err)
}

// Security's MUST on batch 3 (#20369): the pattern is the one chi routed by (RawPath, the Hub's encoded path), never the decoded path, and a write that matches no route still leaves a row.
func TestPairRowsFollowTheRoutedPatternAndNeverGoSilent(t *testing.T) {
	g := newInteg(t)
	ctx := context.Background()
	last := func(before int) []board.HubOperatorAction {
		acts, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
		require.NoError(t, err)
		return acts[:len(acts)-before]
	}
	size := func() int {
		acts, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
		require.NoError(t, err)
		return len(acts)
	}
	for _, c := range []struct{ name, path, want string }{
		{"an encoded letter", "/api/board/%70roj/messages", "/api/board/{project}/messages"},
		{"a route no guard answers for", "/api/board/proj/tasks/1/nudge", "/api/board/{project}/tasks/{taskID}/nudge"},
	} {
		before := size()
		code, body := g.hub("owner", integOwner, "POST", c.path, `{"secret":"SENTINEL"}`, nil)
		rows := last(before)
		require.Len(t, rows, 1, "%s: one row (answered %d %s; rows %+v)", c.name, code, body, rows)
		assert.Equal(t, c.want, rows[0].Path, c.name)
		assert.Equal(t, testLinkID, rows[0].ViaLink, c.name)
		assert.Equal(t, integOwner, rows[0].ViaHubUser, c.name)
		assert.Equal(t, code, rows[0].Status, c.name)
		assert.NotContains(t, rows[0].Path+rows[0].Project, "SENTINEL", c.name)
	}
}

// The connector refuses an encoded slash, but the wrapper must not depend on that: with the Hub's raw path set (%2F), chi routes by it, and so does the pattern lookup.
func TestPairRowsUseRawPathWhenAGuardRefusesBeforeRouting(t *testing.T) {
	g := newInteg(t)
	ctx := context.Background()
	mux := chi.NewRouter()
	stamp := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(board.WithActionVia(r.Context(), board.ActionVia{LinkID: testLinkID, HubUser: integOwner})))
		})
	}
	set := routes.PairRecorded{"POST /api/board/{project}/messages": true}
	// a global guard that refuses before routing, with the wrapper in front of it as in the router
	outer := chi.NewRouter()
	outer.Use(stamp)
	outer.Use(routes.RecordPairWrites(g.srv.boardStore, set, nil, mux))
	outer.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusForbidden) })
	})
	outer.Get("/never", func(http.ResponseWriter, *http.Request) {}) // chi builds the middleware chain once a route exists
	mux.Post("/api/board/{project}/messages", func(http.ResponseWriter, *http.Request) {})
	before, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
	require.NoError(t, err)
	req := httptest.NewRequest("POST", "/api/board/a/b/messages", nil) // Path decoded: no such route
	req.URL.RawPath = "/api/board/a%2Fb/messages"                      // the path as the Hub sent it: the route with project a%2Fb
	outer.ServeHTTP(httptest.NewRecorder(), req)
	after, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
	require.NoError(t, err)
	rows := after[:len(after)-len(before)]
	require.Len(t, rows, 1, "%+v", rows)
	assert.Equal(t, "/api/board/{project}/messages", rows[0].Path, "the pattern chi would route by, not the decoded path")
	assert.Equal(t, 403, rows[0].Status)
	assert.Equal(t, testLinkID, rows[0].ViaLink)
	assert.Equal(t, integOwner, rows[0].ViaHubUser)

	// a tunneled write that matches no route is never silent: a row with the method, the word unmatched and no path
	before = after
	outer.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/nosuch/SENTINEL", nil))
	after, err = g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
	require.NoError(t, err)
	rows = after[:len(after)-len(before)]
	require.Len(t, rows, 1, "%+v", rows)
	assert.Equal(t, routes.UnmatchedPairPath, rows[0].Path)
	assert.Equal(t, "POST", rows[0].Method)
	assert.Equal(t, testLinkID, rows[0].ViaLink)
	assert.Equal(t, integOwner, rows[0].ViaHubUser)
}

// A loop of refused writes cannot fill the table: past the per-link cap the rows stop, and a served write is still recorded.
func TestRefusedPairRowsAreCappedPerLink(t *testing.T) {
	g := newInteg(t)
	ctx := context.Background()
	acts0, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
	require.NoError(t, err)
	for i := 0; i < 80; i++ {
		g.hub("owner", integOwner, "POST", "/api/device-keys/message", `{}`, nil)
	}
	acts, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
	require.NoError(t, err)
	added := len(acts) - len(acts0)
	assert.LessOrEqual(t, added, 30, "refused rows are capped per link per minute")
	assert.Greater(t, added, 0, "refused rows are recorded")
}

// pairConcretePath gives a route pattern a path to call: a content digest (64 hex) where the route names an artifact, 1 for every other placeholder. A call that finds nothing (404) is as good as any
// answer: the proof is the row.
func pairConcretePath(pattern string) string {
	segs := strings.Split(pattern, "/")
	for i, s := range segs {
		if !strings.HasPrefix(s, "{") {
			continue
		}
		if s == "{digest}" || (s == "{id}" && i > 0 && segs[i-1] == "artifacts") {
			segs[i] = strings.Repeat("a", 64)
		} else {
			segs[i] = "1"
		}
	}
	return strings.Join(segs, "/")
}
