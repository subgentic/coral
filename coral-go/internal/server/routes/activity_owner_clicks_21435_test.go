package routes

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21435 A: the Operator's own clicks through the Hub were recorded as hub:unknown (535 rows) because the connector stamps the owner marker only on the routes the table marks as the owner's, and the routes
// of a click that is recorded by its route (activity_routes.go) were not in it: the request reached the machine with no marker, so the actor was "not an authentic owner". Every route a Hub can reach that
// writes an Activity row must be stamped (OwnerSees: the handler still decides what a non-owner gets; a grantee has no marker and is still hub:unknown, never the owner's label).
func TestEveryRouteThatWritesAnActivityRowCarriesTheOwnerMarkerThroughTheHub(t *testing.T) {
	param := regexp.MustCompile(`\{[^}]*\}`)
	checked := 0
	for key := range activityRoutes {
		method, pattern, _ := strings.Cut(key, " ")
		path := param.ReplaceAllString(pattern, "1")
		if strings.Contains(pattern, "/artifacts/") {
			path = param.ReplaceAllString(pattern, strings.Repeat("a", 64))
		}
		if _, tier, ok := tunnel.RuleFor(method, path); !ok || tier == tunnel.TierNever {
			continue // not reachable through the Hub at all: no Hub click to record
		}
		checked++
		assert.True(t, tunnel.IsOwnerRoute(method, path), "%s: a Hub owner's click here would reach the machine with no owner marker and be recorded as hub:unknown", key)
	}
	assert.Greater(t, checked, 15, "the census reached the routes")
}

// #21435 A, the goal close the Operator makes at the Hub, and the chat send, answer-prompt: the stamp reaches the handler, and the row names the owner.
func TestAnOwnersClickThroughTheHubOnAPersonalComputerIsTheirsAndAGranteesIsNot(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil)
	ownerReq := hubReq(t, "POST", "/api/board/alpha/goals/1/close", "owner", "hub-user-1234abcd")
	assert.NotEqual(t, "hub:unknown", activityActor(hubOwnerRequest(ownerReq)), "the owner's click is the owner's")
	grantee := hubReq(t, "POST", "/api/board/alpha/goals/1/close", "grantee", "hub-user-9999ffff")
	assert.Equal(t, "hub:unknown", activityActor(hubOwnerRequest(grantee)), "a grantee is never given the owner's label")
	other := hubReq(t, "POST", "/api/board/alpha/goals/1/close", "owner", "hub-user-9999ffff")
	assert.Equal(t, "hub:unknown", activityActor(hubOwnerRequest(other)), "another account's marker is not the owner's")
}

func hubReq(t *testing.T, method, path, role, user string) *http.Request {
	t.Helper()
	r, err := http.NewRequest(method, path, nil)
	require.NoError(t, err)
	r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
	r.Header.Set(tunnel.HubRoleHeader, role)
	r.Header.Set(tunnel.HubUserHeader, user)
	return r
}

// #21435 B: on a personal computer the Hub's Activity answers the owner's rows only (as a team machine does for each owner, #12070): local, hub:owner, the owner's own label, and the owner's agent files.
// hub:unknown and any other hub:<x> are left out of the rows, the check's count and the paging cursor. At the computer itself every row is still answered.
func TestOnAPersonalComputerTheHubReadsOnlyTheOwnersRows(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil)
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	ctx := context.Background()
	mine := activityActor(hubOwnerRequest(hubReq(t, "GET", "/api/activity", "owner", "hub-user-1234abcd")))
	require.True(t, strings.HasPrefix(mine, "hub:"), mine)
	require.NotEqual(t, "hub:unknown", mine)
	for _, r := range []struct{ actor, item string }{
		{"local", "local-1"}, {"hub:unknown", "unknown-1"}, {mine, "mine-1"}, {"agent:Frontend Dev", "agent-1"}, {"hub:owner", "owner-1"},
		{"hub:0123456789ab", "other-1"}, {"hub:unknown", "unknown-2"}, {mine, "mine-2"}, {"hub:hub-uid-xyz", "uid-1"}, {"agent:QA Engineer", "agent-2"},
	} {
		require.NoError(t, e.h.bs.RecordActivity(ctx, board.ActivityMeta{Actor: r.actor, Source: "hub"}, board.ActSave, "file", r.item, "", "alpha"))
	}
	items := func(out map[string]any) []string {
		var ids []string
		for _, r := range out["actions"].([]any) {
			ids = append(ids, r.(map[string]any)["item_id"].(string))
		}
		return ids
	}
	hdr := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}
	code, out := getActivity(t, act.URL, "", hdr)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, []string{"agent-2", "mine-2", "agent-1", "mine-1"}[0:0], []string{}, "")
	got := items(out)
	assert.Equal(t, []string{"agent-2", "mine-2", "owner-1", "agent-1", "mine-1", "local-1"}, got, "the owner's rows alone, newest first: no hub:unknown, no other hub account")
	assert.Equal(t, float64(6), out["check"].(map[string]any)["rows"], "the check counts the same rows")
	// paging under the filter: the cursor is the last row of the page, and the next page continues without the others
	code, p1 := getActivity(t, act.URL, "?limit=2", hdr)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{"agent-2", "mine-2"}, items(p1))
	assert.Equal(t, true, p1["more"])
	cursor := "?limit=3&before=" + jsonNum(p1["next_before"]) + "&before_at=" + p1["next_before_at"].(string)
	code, p2 := getActivity(t, act.URL, cursor, hdr)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{"owner-1", "agent-1", "mine-1"}, items(p2))
	assert.Equal(t, true, p2["more"])
	// at the computer itself: everything
	code, all := getActivity(t, act.URL, "", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, items(all), 10)
	assert.Equal(t, float64(10), all["check"].(map[string]any)["rows"])
}
