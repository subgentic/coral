package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// approvingHub is a stub Hub that gives a device code and approves it on the first poll, as a Hub whose person pressed Approve.
func approvingHub(t *testing.T, serverID, label string) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var starts atomic.Int64
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("POST /api/enroll/start", func(w http.ResponseWriter, r *http.Request) {
		starts.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"device_code": strings.Repeat("e", 43), "user_code": "WXYZ-1234",
			"verification_url": srv.URL + "/enroll?code=WXYZ-1234", "interval": 2, "expires_in": 600})
	})
	mux.HandleFunc("POST /api/enroll/poll", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"server_token": "coralhub_srv_" + serverID + "_" + strings.Repeat("b", 43), "server_id": serverID, "label": label})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &starts
}

// #20347, goal #269 done-when: two Hubs linked to one Coral. Hub A is the enrollment, Hub B is added by address and approved by its stub. Each sends an action through the real router (the connector's stamp:
// its link and its person); the Operator-actions log names the right Hub and person; a link that is not active gets 403; removing A leaves B working.
func TestTwoHubsLinkedToOneCoralEndToEnd(t *testing.T) {
	ctx := context.Background()
	rev := &fakeRevoker{}
	r, cs, _, a := linkedRemoteWithManager(t)
	r.srv.cloudHandler.SetLinkRevoker(rev)
	r.srv.cloudHandler.SetLinkedCheck(func() bool { return true })
	store.AllowSecondLinkForTest(t)
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()

	// Hub B is added by address; its stub approves at once.
	hubB, starts := approvingHub(t, "srv_bbbb2222", "Hub B")
	rec := call(h, "POST", "/api/cloud/links", `{"hub":"`+hubB.URL+`","cap":"launch"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.EqualValues(t, 1, starts.Load())
	var b *store.CloudLink
	require.Eventually(t, func() bool {
		b, _ = cs.LinkByOrigin(ctx, hubB.URL)
		return b != nil
	}, 10*time.Second, 20*time.Millisecond, "Hub B is linked once its stub approves")
	require.NotEqual(t, a.LinkID, b.LinkID)
	assert.Equal(t, store.LinkStateActive, b.State)
	assert.Equal(t, store.LinkSourceAdded, b.Source)
	ls, _ := cs.ListLinks(ctx)
	require.Len(t, ls, 2)

	// Each link may do what its own cap says: Hub A is the enrollment (the setting), B is set above.
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"launch"}`, js).Code)

	pinned, err := cs.PinOwnerUser(ctx, "srv_a", "hub-user-aaaa1111")
	require.NoError(t, err)
	require.True(t, pinned)
	person := map[string]string{a.LinkID: "hub-user-aaaa1111", b.LinkID: "hub-user-bbbb2222"}
	send := func(link string) *httptest.ResponseRecorder {
		hdr := map[string]string{"Content-Type": "application/json", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: link, tunnel.ActorHeader: person[link],
			tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: person[link]}
		return call(h, "PUT", "/api/board/team/settings", `{"subscriber_id":"Operator","cross_team_messaging":true}`, hdr)
	}
	// A message through a link works for each Hub (a plain read stands for "the Hub is served").
	read := func(link string) int {
		hdr := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: link, tunnel.ActorHeader: person[link]}
		return call(h, "GET", "/api/health", "", hdr).Code
	}
	assert.Equal(t, 200, read(a.LinkID), "Hub A is served")
	assert.Equal(t, 200, read(b.LinkID), "Hub B is served")
	// Each Hub sends an action as its owner. Hub A is the enrollment with a pinned owner, so it is served; Hub B is an added link with no pinned owner, so the guard refuses it. Both are in the Operator-actions
	// log with their own link and their own Hub person, never each other's.
	assert.Equal(t, 200, send(a.LinkID).Code, "Hub A's owner acts")
	assert.Equal(t, 403, send(b.LinkID).Code, "an added Hub has no pinned owner here yet: refused")
	acts, err := r.srv.boardStore.RecentHubOperatorActions(ctx, 50)
	require.NoError(t, err)
	rows := map[string][3]any{}
	for _, x := range acts {
		if x.Path == "/api/board/team/settings" {
			rows[x.ViaLink] = [3]any{x.ViaHubUser, x.Status, x.Method}
		}
	}
	require.Len(t, rows, 2, "one row per Hub: %v", acts)
	assert.Equal(t, [3]any{"hub-user-aaaa1111", 200, "PUT"}, rows[a.LinkID], "Hub A's row names Hub A and its person")
	assert.Equal(t, [3]any{"hub-user-bbbb2222", 403, "PUT"}, rows[b.LinkID], "Hub B's row names Hub B and its person")

	// A link that is not active is refused (403 hub_link_refused) before any handler.
	for _, st := range []string{"paused", "revoked"} {
		_, err = r.db.ExecContext(ctx, "UPDATE cloud_link SET state = ? WHERE link_id = ?", st, b.LinkID)
		require.NoError(t, err)
		rec := call(h, "GET", "/api/health", "", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: b.LinkID, tunnel.ActorHeader: person[b.LinkID]})
		assert.Equal(t, 403, rec.Code, st)
		assert.Contains(t, rec.Body.String(), cloud.LinkRefusedCode, st)
		assert.Equal(t, 200, read(a.LinkID), "Hub A is still served while B is %s", st)
	}
	_, err = r.db.ExecContext(ctx, "UPDATE cloud_link SET state = 'active' WHERE link_id = ?", b.LinkID)
	require.NoError(t, err)
	assert.Equal(t, 200, read(b.LinkID))

	// Removing Hub A (its tunnel stops, the Hub is asked to forget this computer) leaves Hub B working.
	rec = call(h, "DELETE", "/api/cloud/links/"+a.LinkID, "", js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	rec = call(h, "GET", "/api/health", "", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: a.LinkID, tunnel.ActorHeader: person[a.LinkID]})
	assert.Equal(t, 403, rec.Code, "a removed link is refused")
	assert.Equal(t, 200, read(b.LinkID), "Hub B still works after A is removed")
	gb, err := cs.LinkByOrigin(ctx, hubB.URL)
	require.NoError(t, err)
	assert.Equal(t, store.LinkStateActive, gb.State)
}
