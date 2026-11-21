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

// ownerHub is a stub Hub that approves a device code on the first poll and names an owner (account and hub user) in its answer, as a Hub whose person pressed Approve. owner "" names none.
func ownerHub(t *testing.T, serverID, label, account, owner string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	var starts atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/enroll/start", func(w http.ResponseWriter, r *http.Request) {
		starts.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"device_code": strings.Repeat("e", 43), "user_code": "WXYZ-1234",
			"verification_url": srv.URL + "/enroll?code=WXYZ-1234", "interval": 2, "expires_in": 600})
	})
	mux.HandleFunc("POST /api/enroll/poll", func(w http.ResponseWriter, r *http.Request) {
		reply := map[string]any{"server_token": "coralhub_srv_" + serverID + "_" + strings.Repeat("b", 43), "server_id": serverID, "label": label}
		if owner != "" {
			reply["account"], reply["owner_user"] = account, owner
		}
		json.NewEncoder(w).Encode(reply)
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

const (
	personA = "hub-user-aaaa1111"
	personB = "hub-user-bbbb2222"
	acctB   = "11111111-2222-4333-8444-555555555555"
)

func TestAnAddedHubsOwnerIsPinnedOnlyByTheOperatorAtThisComputer(t *testing.T) {
	ctx := context.Background()
	r, cs, _, a := linkedRemoteWithManager(t)
	r.srv.cloudHandler.SetLinkRevoker(&fakeRevoker{})
	r.srv.cloudHandler.SetLinkedCheck(func() bool { return true })
	store.AllowSecondLinkForTest(t)
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()
	pinned, err := cs.PinOwnerUser(ctx, "srv_a", personA)
	require.NoError(t, err)
	require.True(t, pinned)

	hubB := ownerHub(t, "srv_bbbb2222", "Hub B", acctB, personB)
	rec := call(h, "POST", "/api/cloud/links", `{"hub":"`+hubB.URL+`","cap":"launch"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var b *store.CloudLink
	require.Eventually(t, func() bool { b, _ = cs.LinkByOrigin(ctx, hubB.URL); return b != nil }, 10*time.Second, 20*time.Millisecond)

	// 1. The owner the Hub named is not stored as the owner: it is a candidate the Operator sees.
	assert.Empty(t, b.OwnerUser, "a label a Hub sends is never recorded by itself")
	list := call(h, "GET", "/api/cloud/links", "", js)
	require.Equal(t, 200, list.Code)
	assert.Contains(t, list.Body.String(), `"owner_candidate":"`+personB+`"`)

	via := func(link, person string) map[string]string {
		return map[string]string{"Content-Type": "application/json", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: link, tunnel.ActorHeader: person,
			tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: person}
	}
	ownerCall := func(link, person string) *httptest.ResponseRecorder {
		return call(h, "GET", "/api/activity", "", via(link, person))
	}
	// 2. Before the confirm Hub B's owner is refused on an owner-only route, in the words that say what to do; Hub A's owner still acts.
	rec = ownerCall(b.LinkID, personB)
	assert.Equal(t, 403, rec.Code, rec.Body.String())
	ra := ownerCall(a.LinkID, personA)
	assert.Equal(t, 200, ra.Code, "Hub A's owner acts: "+ra.Body.String())

	// 3. The confirm names the exact candidate: a different name, and a Hub that has none, are refused; the row is unchanged.
	conf := func(hub, cand string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"hub": hub, "candidate": cand})
		return call(h, "POST", "/api/cloud/links/confirm-owner", string(body), js)
	}
	rec = conf(hubB.URL, "hub-user-cccc3333")
	assert.Equal(t, 409, rec.Code)
	assert.Contains(t, rec.Body.String(), "owner_candidate_mismatch")
	rec = conf("http://127.0.0.1:1", personB)
	assert.Equal(t, 409, rec.Code)
	assert.Contains(t, rec.Body.String(), "no_owner_candidate")
	rec = conf(hubB.URL, "")
	assert.Equal(t, 400, rec.Code, "the name is required: it is never taken from the Hub alone")
	b, _ = cs.LinkByOrigin(ctx, hubB.URL)
	assert.Empty(t, b.OwnerUser)
	assert.Equal(t, 403, ownerCall(b.LinkID, personB).Code)

	// 4. Never through Coral Hub: a request the connector stamped is refused, and the owner stays unset.
	rec = call(h, "POST", "/api/cloud/links/confirm-owner", `{"hub":"`+hubB.URL+`","candidate":"`+personB+`"}`, via(b.LinkID, personB))
	assert.Equal(t, 403, rec.Code)
	b, _ = cs.LinkByOrigin(ctx, hubB.URL)
	assert.Empty(t, b.OwnerUser)

	// 5. The right candidate, by the Operator at this computer, pins it.
	rec = conf(hubB.URL, personB)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	b, _ = cs.LinkByOrigin(ctx, hubB.URL)
	assert.Equal(t, personB, b.OwnerUser)
	assert.Equal(t, acctB, b.OwnerAccount)
	evs, err := cs.ListLinkEvents(ctx, b.LinkID, 10)
	require.NoError(t, err)
	var found bool
	for _, e := range evs {
		if e.Action == store.LinkEventOwnerConfirmed {
			found = true
			assert.Equal(t, "candidate", e.Detail)
			assert.NotContains(t, e.Detail+e.HubOrigin, personB, "the log row names no label")
		}
	}
	assert.True(t, found, "the confirm is in the log")
	assert.NotContains(t, call(h, "GET", "/api/cloud/links", "", js).Body.String(), "owner_candidate", "the candidate is spent")
	// A recorded label is never replaced.
	assert.ErrorIs(t, cs.ConfirmLinkOwner(ctx, b.LinkID, acctB, "hub-user-dddd4444", "request"), store.ErrOwnerAlreadyConfirmed)

	// 6. Each link has its own owner: B's person acts through B, and neither person acts through the other's link.
	assert.Equal(t, 200, ownerCall(b.LinkID, personB).Code, "Hub B's owner acts through Hub B")
	assert.Equal(t, 403, ownerCall(b.LinkID, personA).Code, "Hub A's person through Hub B")
	assert.Equal(t, 403, ownerCall(a.LinkID, personB).Code, "Hub B's person through Hub A")
	assert.Equal(t, 200, ownerCall(a.LinkID, personA).Code)

	// 7. A stamped request with an id no link has is refused before any owner check; it never reaches the first link's label.
	rec = ownerCall("lnk-00000000", personA)
	assert.Equal(t, 403, rec.Code)
	assert.Contains(t, rec.Body.String(), cloud.LinkRefusedCode)

	// 8. Removing the link takes its owner with it: adding the same Hub again starts with none.
	rec = call(h, "DELETE", "/api/cloud/links/"+b.LinkID, "", js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	_, err = cs.LinkByOrigin(ctx, hubB.URL)
	require.Error(t, err)
	rec = call(h, "POST", "/api/cloud/links", `{"hub":"`+hubB.URL+`","cap":"view"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Eventually(t, func() bool { b, _ = cs.LinkByOrigin(ctx, hubB.URL); return b != nil }, 10*time.Second, 20*time.Millisecond)
	assert.Empty(t, b.OwnerUser, "a re-added Hub has no owner until it is confirmed again")
}

// The fallback when the Hub named no owner: Confirm owner for ONE added Hub, one minute, one shot. A request through another link neither uses it nor spends it.
func TestConfirmOwnerForAnAddedHubIsPerLinkAndOneShot(t *testing.T) {
	ctx := context.Background()
	r, cs, _, a := linkedRemoteWithManager(t)
	r.srv.cloudHandler.SetLinkRevoker(&fakeRevoker{})
	r.srv.cloudHandler.SetLinkedCheck(func() bool { return true })
	store.AllowSecondLinkForTest(t)
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()
	pinned, err := cs.PinOwnerUser(ctx, "srv_a", personA)
	require.NoError(t, err)
	require.True(t, pinned)
	hubB := ownerHub(t, "srv_bbbb2222", "Hub B", "", "") // names no owner
	require.Equal(t, 200, call(h, "POST", "/api/cloud/links", `{"hub":"`+hubB.URL+`","cap":"launch"}`, js).Code)
	var b *store.CloudLink
	require.Eventually(t, func() bool { b, _ = cs.LinkByOrigin(ctx, hubB.URL); return b != nil }, 10*time.Second, 20*time.Millisecond)
	assert.NotContains(t, call(h, "GET", "/api/cloud/links", "", js).Body.String(), "owner_candidate")
	rec := call(h, "POST", "/api/cloud/links/confirm-owner", `{"hub":"`+hubB.URL+`","candidate":"`+personB+`"}`, js)
	assert.Equal(t, 409, rec.Code, "no candidate was named: there is nothing to confirm")

	via := func(link, person string) map[string]string {
		return map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: link, tunnel.ActorHeader: person, tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: person}
	}
	read := func(link, person string) *httptest.ResponseRecorder {
		return call(h, "GET", "/api/saved", "", via(link, person))
	}
	assert.Equal(t, 403, read(b.LinkID, personB).Code, "no owner yet, nothing armed")

	// Armed for Hub B: a read through Hub A (its own owner, a different link) neither adopts nor spends it.
	rec = call(h, "POST", "/api/cloud/owner-label/arm", `{"hub":"`+hubB.URL+`"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Equal(t, 200, read(a.LinkID, personA).Code, "Hub A's owner reads as before")
	b, _ = cs.LinkByOrigin(ctx, hubB.URL)
	assert.Empty(t, b.OwnerUser, "a request through another link did not adopt")
	// The first read through Hub B in the minute is the one: its Hub person becomes B's owner. A write would not carry it.
	assert.Equal(t, 403, call(h, "PUT", "/api/board/team/settings", `{"subscriber_id":"Operator","cross_team_messaging":true}`, via(b.LinkID, personB)).Code, "a write never carries the adoption")
	// (that refusal used no arm: writes are refused without using it up)
	assert.Equal(t, 200, read(b.LinkID, personB).Code, "the armed read through Hub B is served as its owner")
	b, _ = cs.LinkByOrigin(ctx, hubB.URL)
	assert.Equal(t, personB, b.OwnerUser)
	// One shot: nothing else is adopted afterwards, and the owner is not replaced.
	assert.Equal(t, 403, read(b.LinkID, personA).Code, "another person through Hub B")
	b, _ = cs.LinkByOrigin(ctx, hubB.URL)
	assert.Equal(t, personB, b.OwnerUser)
	// Arming a Hub that has an owner, or one that is not added, is refused.
	assert.Equal(t, 409, call(h, "POST", "/api/cloud/owner-label/arm", `{"hub":"`+hubB.URL+`"}`, js).Code)
	assert.Equal(t, 404, call(h, "POST", "/api/cloud/owner-label/arm", `{"hub":"http://127.0.0.1:1"}`, js).Code)
}
