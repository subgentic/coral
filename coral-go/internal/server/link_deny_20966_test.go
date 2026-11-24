package server

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20966, the fourth commit: a signed relayed Deny of a join request, the card's second button through a Hub. Interact or more, the owner's own device, the same shut gate; it also cancels a request that was
// allowed and not yet finished (so the code stops working at once). It holds no secret, so there is no box.

func (g *linkRig) deny(id string, mut func(*relayReq)) *httptest.ResponseRecorder {
	return g.do(devicekey.DenyLink, "POST", "/api/cloud/link-requests/"+id+"/deny", `{}`, "", mut)
}

func TestARelayedDenyEndsAWaitingRequestAndCountsAsADenial(t *testing.T) {
	g := newLinkRig(t, true)
	id := g.pending(t, "interact")
	rec := g.deny(id, nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	st, err := g.cs.LinkRequestByID(context.Background(), id, time.Now())
	require.NoError(t, err)
	assert.Equal(t, "denied", st.State)
	// Attributed to the link, in the Hub's record, with no query and no secret.
	hub, err := g.d.r.srv.boardStore.RecentHubOperatorActions(context.Background(), 20)
	require.NoError(t, err)
	seen := false
	for _, a := range hub {
		seen = seen || (a.Method == "POST" && a.Path == "/api/cloud/link-requests/"+id+"/deny" && a.ViaLink == testLinkID)
	}
	assert.True(t, seen, "%+v", hub)
}

func TestARelayedDenyOfAnAllowedRequestCancelsItsCode(t *testing.T) {
	g := newLinkRig(t, true)
	ctx := context.Background()
	id, secret, err := g.cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "interact", "", time.Now())
	require.NoError(t, err)
	code, _, err := g.cs.AllowLinkRequest(ctx, id, "interact", time.Now())
	require.NoError(t, err)
	rec := g.deny(id, nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	st, _ := g.cs.LinkRequestByID(ctx, id, time.Now())
	assert.Equal(t, "expired", st.State, "a cancel is not a denial: it does not count toward the mute")
	_, _, err = g.cs.FinishLinkRequest(ctx, id, secret, code, time.Now())
	assert.Error(t, err, "the code no longer finishes it")
}

func TestARelayedDenyNeedsTheOwnersSignedDeviceAtInteractOrMore(t *testing.T) {
	g := newLinkRig(t, true)
	ctx := context.Background()
	id := g.pending(t, "interact")
	check := func(why string, mut func(*relayReq)) {
		rec := g.deny(id, mut)
		assert.NotEqual(t, 200, rec.Code, "%s: %s", why, rec.Body.String())
		st, _ := g.cs.LinkRequestByID(ctx, id, time.Now())
		assert.Equal(t, "pending", st.State, why)
	}
	viewKey, viewKid := g.ownerKeyOfMode("view")
	check("a device whose own mode is view", func(q *relayReq) { q.priv, q.kid = viewKey, viewKid })
	check("a Hub person's bound key", func(q *relayReq) { q.priv, q.kid, q.actor = g.bound, g.bndK, relayPerson })
	rec := call(g.d.r.srv.Router(), "POST", "/api/cloud/link-requests/"+id+"/deny", `{}`, map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.ActorHeader: relayOwner, tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: relayOwner, "Content-Type": "application/json"})
	assert.NotEqual(t, 200, rec.Code, "no signature at all: %s", rec.Body.String())
	st, _ := g.cs.LinkRequestByID(ctx, id, time.Now())
	assert.Equal(t, "pending", st.State)
}

func TestARelayedDenyIsShutWhileTheGateIsShut(t *testing.T) {
	g := newLinkRig(t, false)
	id := g.pending(t, "interact")
	rec := g.deny(id, nil)
	assert.Equal(t, 403, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "hub_route_refused")
	st, _ := g.cs.LinkRequestByID(context.Background(), id, time.Now())
	assert.Equal(t, "pending", st.State)
}

// Security's SHOULD on #20966: the owner check is inside relayedLink, so every relayed join kind asks it, not only the reads. A Hub person who is not the owner is refused even with a signature from the owner's key.
func TestEveryRelayedJoinKindAsksTheOwnerCheckInsideRelayedLink(t *testing.T) {
	g := newLinkRig(t, true)
	id := g.pending(t, "interact")
	b := newBrowser(t)
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"deny": g.deny(id, func(q *relayReq) { q.actor = relayPerson }),
		"make": func() *httptest.ResponseRecorder {
			r, _ := g.makeKey(t, "Hub C", b, func(q *relayReq) { q.actor = relayPerson })
			return r
		}(),
		"revoke": g.do(devicekey.RevokeLinkKey, "DELETE", "/api/cloud/link-keys/lk-00000000", "", "", func(q *relayReq) { q.actor = relayPerson }),
	} {
		assert.NotEqual(t, 200, rec.Code, "%s: %s", name, rec.Body.String())
	}
	assert.Empty(t, g.keys())
	st, _ := g.cs.LinkRequestByID(context.Background(), id, time.Now())
	assert.Equal(t, "pending", st.State)
}
