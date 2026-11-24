package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20883 (goal #269): a Hub's owner gives and ends a member's access, signed twice by the owner's own device: the relayed (v3) signature over the request, and the grant's own signature over its digest for THIS
// computer (#20649). Through the connector, per rule of the design (artifact 478ded64, Security's #20898).

type grantRig struct {
	*relayRig
	n int
}

func newGrantRig(t *testing.T) *grantRig {
	t.Helper()
	tunnel.OpenMemberRelayedForTest(t)
	g := &grantRig{relayRig: newRelayRig(t)}
	_, err := g.d.r.srv.boardStore.Subscribe(context.Background(), "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	return g
}

// ownerKeyOfMode adds another owner device at a mode.
func (g *grantRig) ownerKeyOfMode(mode string) (*ecdsa.PrivateKey, string) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(g.t, err)
	e, _ := priv.ECDH()
	raw := e.PublicKey().Bytes()
	kid := rb64.EncodeToString(sha(raw))
	_, err = g.d.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: kid, PK: raw, Label: "Owner phone", Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, time.Now().Add(-time.Hour))
	require.NoError(g.t, err)
	return priv, kid
}

// grantBody is the body of a grant the device signs for this computer; edit changes the grant after the digest was taken (what a Hub or a bad signer would do).
func (g *grantRig) grantBody(priv *ecdsa.PrivateKey, kid string, in board.NewMemberGrant, edit func(*board.NewMemberGrant)) string {
	g.n++
	in.Nonce = fmt.Sprintf("%022d", g.n+1000*int(time.Now().UnixNano()%997))
	in.Ts = time.Now().Unix()
	if in.Days == 0 {
		in.Days = 7
	}
	sig := signP1363(g.t, priv, devicekey.GrantSigningInput(g.d.key.Computer(), board.MemberGrantDigest(in)))
	if edit != nil {
		edit(&in)
	}
	return fmt.Sprintf(`{"link_id":%q,"hub_user":%q,"level":%q,"scope_kind":%q,"scope_id":%q,"artifacts":%v,"files":%v,"pinned_folder":%q,"label":"Ada from Acme","days":%d,"signature":{"kid":%q,"nonce":%q,"ts":%d,"sig":%q}}`,
		in.LinkID, in.HubUser, in.Level, in.ScopeKind, in.ScopeID, in.FlagArtifacts, in.FlagFiles, in.PinnedFolder, in.Days, kid, in.Nonce, in.Ts, sig)
}

func viewGrant(link string) board.NewMemberGrant {
	return board.NewMemberGrant{LinkID: link, HubUser: "hub-user-cccc3333", Level: "view", ScopeKind: "board", ScopeID: "team1", BoardID: "team1", Days: 7}
}

func (g *grantRig) rows() []board.MemberGrant {
	gs, err := g.d.r.srv.boardStore.ListMemberGrants(context.Background(), "", time.Now())
	require.NoError(g.t, err)
	return gs
}

func (g *grantRig) post(priv *ecdsa.PrivateKey, kid, actor, target, body string, mut func(*relayReq)) *httptest.ResponseRecorder {
	q := relayReq{kind: devicekey.GrantMember, method: "POST", target: target, body: body, priv: priv, kid: kid, actor: actor}
	if mut != nil {
		mut(&q)
	}
	return g.signed(q)
}

const teamGrants = "/api/board/team1/member-grants"

func TestARelayedOwnerSignedGrantGivesAndEndsAMembersAccess(t *testing.T) {
	g := newGrantRig(t)
	body := g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), nil)
	rec := g.post(g.owner, g.ownK, relayOwner, teamGrants, body, nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	rows := g.rows()
	require.Len(t, rows, 1)
	assert.Equal(t, testLinkID, rows[0].LinkID, "the row names the link it arrived on")
	assert.Equal(t, g.ownK, rows[0].SignedBy, "and the device that signed it")
	assert.Equal(t, "team1", rows[0].BoardID)

	// It is attributed: the Operator-actions log has the row, and the team's board has a notice (outside text drawn as plain text, capped).
	actions, err := g.d.r.srv.boardStore.RecentHubOperatorActions(context.Background(), 20)
	require.NoError(t, err)
	found := false
	for _, a := range actions {
		found = found || (a.Method == "POST" && strings.Contains(a.Path, "member-grants") && a.ViaLink == testLinkID)
	}
	assert.True(t, found, "an Operator-actions row for the relayed grant: %+v", actions)
	msgs, err := g.d.r.srv.boardStore.ListMessages(context.Background(), "team1", 20, 0, 0)
	require.NoError(t, err)
	notice := false
	for _, m := range msgs {
		notice = notice || (m.Origin != nil && *m.Origin == board.OriginHubNotice && strings.Contains(m.Content, "view access"))
	}
	assert.True(t, notice, "a notice on the team's board")

	// The same owner key ends it, by the id in the signed path; an id of nothing and an id of another link answer alike.
	rev := func(id string) *httptest.ResponseRecorder {
		return g.post(g.owner, g.ownK, relayOwner, teamGrants+"/"+id, "", func(q *relayReq) { q.method = "DELETE" })
	}
	missing := rev("nosuchgrant")
	assert.Equal(t, 404, missing.Code, missing.Body.String())
	other, err := g.d.r.srv.boardStore.CreateMemberGrant(context.Background(), board.NewMemberGrant{LinkID: "lnk-00000002", HubUser: "hub-user-dddd4444", Level: "view", ScopeKind: "board", ScopeID: "team1", BoardID: "team1", Label: "B", Days: 7,
		SignedBy: g.ownK, Nonce: fmt.Sprintf("%022d", 7), Ts: time.Now().Unix()})
	require.NoError(t, err)
	foreign := rev(other.GrantID)
	assert.Equal(t, 404, foreign.Code)
	assert.Equal(t, missing.Body.String(), foreign.Body.String(), "a Hub cannot tell another link's grant from a missing one")
	assert.Len(t, g.rows(), 2, "neither ended anything")
	ok := rev(rows[0].GrantID)
	require.Equal(t, 200, ok.Code, ok.Body.String())
	live := 0
	for _, r := range g.rows() {
		if r.LinkID == testLinkID {
			live++
		}
	}
	assert.Zero(t, live, "access ended")
}

func TestARelayedGrantIsRefusedUnlessEveryRulePasses(t *testing.T) {
	g := newGrantRig(t)
	viewKey, viewKid := g.ownerKeyOfMode("view")
	good := func() string { return g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), nil) }
	for _, c := range []struct {
		name string
		do   func() *httptest.ResponseRecorder
		code string // the reply code of the guard, or "" for a handler refusal
		not  int    // a status that must not be seen
	}{
		{"a key bound to a Hub person", func() *httptest.ResponseRecorder {
			return g.post(g.bound, g.bndK, relayPerson, teamGrants, g.grantBody(g.bound, g.bndK, viewGrant(testLinkID), nil), nil)
		}, "outside_pair", 200},
		{"the owner key signing as another person", func() *httptest.ResponseRecorder {
			return g.post(g.owner, g.ownK, relayPerson, teamGrants, good(), nil)
		}, "outside_pair", 200},
		{"the grant's own signature by another key than the request's", func() *httptest.ResponseRecorder {
			return g.post(g.owner, g.ownK, relayOwner, teamGrants, g.grantBody(viewKey, viewKid, viewGrant(testLinkID), nil), nil)
		}, "outside_pair", 200},
		{"a changed body byte", func() *httptest.ResponseRecorder {
			b := good()
			return g.post(g.owner, g.ownK, relayOwner, teamGrants, b+" ", func(q *relayReq) { s := b; q.signed = &s })
		}, "bad_signature", 200},
		{"a signed PUT sent as a POST", func() *httptest.ResponseRecorder {
			return g.signedAs(relayReq{kind: devicekey.GrantMember, method: "POST", target: teamGrants, body: good(), priv: g.owner, kid: g.ownK, actor: relayOwner}, "PUT")
		}, "bad_signature", 200},
		{"the grant changed after its digest was signed", func() *httptest.ResponseRecorder {
			return g.post(g.owner, g.ownK, relayOwner, teamGrants, g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), func(in *board.NewMemberGrant) { in.Days = 6 }), nil)
		}, "", 200},
		{"a link the request did not arrive on", func() *httptest.ResponseRecorder {
			return g.post(g.owner, g.ownK, relayOwner, teamGrants, g.grantBody(g.owner, g.ownK, viewGrant("lnk-00000002"), nil), nil)
		}, "", 200},
		{"a team that is not on this computer", func() *httptest.ResponseRecorder {
			in := viewGrant(testLinkID)
			in.ScopeID, in.BoardID = "ghost", "ghost"
			return g.post(g.owner, g.ownK, relayOwner, "/api/board/ghost/member-grants", g.grantBody(g.owner, g.ownK, in, nil), nil)
		}, "", 200},
		{"a signature too old", func() *httptest.ResponseRecorder {
			return g.post(g.owner, g.ownK, relayOwner, teamGrants, good(), func(q *relayReq) { q.ts = time.Now().Add(-time.Hour) })
		}, "ts_window", 200},
		{"a request that carries no signature at all", func() *httptest.ResponseRecorder {
			return call(g.d.r.srv.Router(), "POST", teamGrants, good(), map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.ActorHeader: relayOwner, tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: relayOwner, "Content-Type": "application/json"})
		}, "bad_form", 200},
	} {
		rec := c.do()
		if c.code != "" {
			assert.Equal(t, c.code, relayCode(rec), "%s: %d %s", c.name, rec.Code, rec.Body.String())
		} else {
			assert.NotEqual(t, 200, rec.Code, "%s: %s", c.name, rec.Body.String())
		}
		assert.Empty(t, g.rows(), "%s: nothing was written", c.name)
	}

	// A full grant: shut by its own gate; opened, it is bounded by the signer's own mode (a view device cannot give it), and a replay of the grant's nonce through a fresh request is refused.
	full := board.NewMemberGrant{LinkID: testLinkID, HubUser: "hub-user-cccc3333", Level: "full", ScopeKind: "computer", Days: 3}
	assert.NotEqual(t, 200, g.post(g.owner, g.ownK, relayOwner, "/api/member-grants", g.grantBody(g.owner, g.ownK, full, nil), nil).Code, "full stays shut for a relayed request")
	board.AllowMemberGatesForTest(t)
	assert.NotEqual(t, 200, g.post(viewKey, viewKid, relayOwner, "/api/member-grants", g.grantBody(viewKey, viewKid, full, nil), nil).Code, "a device whose mode is view cannot give full access")
	assert.Empty(t, g.rows())

	body := good()
	require.Equal(t, 200, g.post(g.owner, g.ownK, relayOwner, teamGrants, body, nil).Code)
	again := g.post(g.owner, g.ownK, relayOwner, teamGrants, body, nil)
	assert.NotEqual(t, 200, again.Code, "the same signed grant sent again with a fresh request: %s", again.Body.String())
	assert.Len(t, g.rows(), 1, "the grant's own nonce is spent once")
}

// Local requests are as before: a person at this computer, no Hub; a request that came through a Hub without the signature is refused by the guard and, if the guard were gone, by the handler.
func TestMemberGrantRoutesStayLocalForEveryoneButASignedOwner(t *testing.T) {
	g := newGrantRig(t)
	rec := call(g.d.r.srv.Router(), "POST", teamGrants, g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), nil), map[string]string{"Content-Type": "application/json"})
	assert.Equal(t, 503, rec.Code, "a local grant needs the local owner-device check, which is not wired: %s", rec.Body.String())
	assert.Empty(t, g.rows())
	// The lists are never a Hub's.
	for _, p := range []string{"/api/member-grants", teamGrants} {
		rec := call(g.d.r.srv.Router(), "GET", p, "", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.ActorHeader: relayOwner, tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: relayOwner})
		assert.NotEqual(t, 200, rec.Code, "GET %s through a Hub", p)
	}
}

// The gate: shut, the four routes answer as they always did, signature or not.
func TestARelayedGrantIsRefusedWhileTheGateIsShut(t *testing.T) {
	g := &grantRig{relayRig: newRelayRig(t)}
	_, err := g.d.r.srv.boardStore.Subscribe(context.Background(), "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	rec := g.post(g.owner, g.ownK, relayOwner, teamGrants, g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), nil), nil)
	assert.Equal(t, 403, rec.Code, rec.Body.String())
	assert.Empty(t, g.rows())
}
