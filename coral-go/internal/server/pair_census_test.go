package server

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

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
	for k := range pairProven {
		require.True(t, registered[k], "%s is listed as proven but is not a route", k)
	}
	got := strings.Join(lines, "\n") + "\n"
	if os.Getenv("PAIR_GOLDEN_UPDATE") == "1" {
		require.NoError(t, os.WriteFile(pairGolden, []byte(got), 0o644))
	}
	want, err := os.ReadFile(pairGolden)
	require.NoError(t, err)
	require.Equal(t, string(want), got, "the Hub-reachable write routes changed: a new one is pending until its record carries the pair; review the diff, then PAIR_GOLDEN_UPDATE=1 go test -tags 'dev fts5' ./internal/server -run TheEveryTunnelWriteRoute")
}
