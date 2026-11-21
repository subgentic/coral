package server

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
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
}

func TestEveryTunnelWriteRouteRecordsThePairOrIsListedPending(t *testing.T) {
	var lines []string
	registered := map[string]bool{}
	for _, rt := range registeredRoutes(t) {
		method, route, _ := strings.Cut(rt, " ")
		registered[method+" "+route] = true
		if method == "GET" || method == "HEAD" || method == "OPTIONS" || (!strings.HasPrefix(route, "/api/") && !strings.HasPrefix(route, "/ws/")) {
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
	count := func() []board.HubOperatorAction {
		acts, err := g.srv.boardStore.RecentHubOperatorActions(ctx, 1000)
		require.NoError(t, err)
		return acts
	}
	for route := range pairRecordedRoutes {
		method, pattern, _ := strings.Cut(route, " ")
		before := len(count())
		code, body := g.hub("owner", integOwner, method, pattern, `{"secret":"SENTINEL"}`, nil)
		_ = body // any answer counts, a refusal too: the row is what is proven
		acts := count()
		rows := acts[:len(acts)-before]
		var mine []board.HubOperatorAction
		for _, a := range rows {
			if a.Method == method && a.Path == pattern {
				mine = append(mine, a)
			}
		}
		require.Len(t, mine, 1, "%s: one row for one tunneled write (rows added: %+v)", route, rows)
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
