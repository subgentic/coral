package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

const grantPerson = "hub-user-bbbb2222"

// ownerDevice wires an owner-device check for one test: a real P-256 key, and Verify accepts only its signature over the digest (P1363, base64url). It shuts the check when the test ends.
type ownerDevice struct {
	key  *ecdsa.PrivateKey
	mode string // the mode the computer's device list gives this key: "" is launch
}

func wireOwnerDevice(t *testing.T) *ownerDevice {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	d := &ownerDevice{key: k}
	routes.SetMemberVerify(func(_ context.Context, digest []byte, kid, sig string) (string, error) {
		raw, err := base64.RawURLEncoding.DecodeString(sig)
		if err != nil || len(raw) != 64 || kid != testOwnerKID {
			return "", errors.New("no")
		}
		h := sha256.Sum256(digest)
		if !ecdsa.Verify(&k.PublicKey, h[:], new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:])) {
			return "", errors.New("no")
		}
		if d.mode == "" {
			return "launch", nil
		}
		return d.mode, nil
	})
	t.Cleanup(func() { routes.SetMemberVerify(nil) })
	return d
}

const testOwnerKID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

var grantNonce int

// sign makes the body of a signed grant request for what the owner's device agrees to; mutate changes the request after it was signed.
func (d *ownerDevice) sign(t *testing.T, g board.NewMemberGrant, ts time.Time, flip bool) string {
	grantNonce++
	g.Nonce = fmt.Sprintf("%022d", grantNonce)
	g.Ts = ts.Unix()
	h := sha256.Sum256(board.MemberGrantDigest(g))
	r, s, err := ecdsa.Sign(rand.Reader, d.key, h[:])
	require.NoError(t, err)
	raw := make([]byte, 64)
	r.FillBytes(raw[:32])
	s.FillBytes(raw[32:])
	if flip {
		raw[5] ^= 1
	}
	return fmt.Sprintf(`{"link_id":%q,"hub_user":%q,"level":%q,"scope_kind":%q,"scope_id":%q,"artifacts":%v,"files":%v,"pinned_folder":%q,"label":"Ada from Acme","days":%d,"signature":{"kid":%q,"nonce":%q,"ts":%d,"sig":%q}}`,
		g.LinkID, g.HubUser, g.Level, g.ScopeKind, g.ScopeID, g.FlagArtifacts, g.FlagFiles, g.PinnedFolder, g.Days, testOwnerKID, g.Nonce, g.Ts, base64.RawURLEncoding.EncodeToString(raw))
}

// #20511 (Security B1-B8): a grant is written, listed and revoked only by the person at this computer, only with the signature of the owner's own device, never exceeds the cap of the link it names, and is
// keyed by (link, Hub person, scope).
func TestMemberGrantsAreSignedByTheOwnersDeviceAndBoundedByTheLinkCap(t *testing.T) {
	ctx := context.Background()
	r, cs, l := linkedRemote(t, &fakeRevoker{})
	h := r.srv.Router()
	_, err := r.srv.boardStore.Subscribe(ctx, "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	js := map[string]string{"Content-Type": "application/json"}
	path := "/api/board/team1/member-grants"
	count := func() int { gs, _ := r.srv.boardStore.ListMemberGrants(ctx, "", time.Now()); return len(gs) }
	view := board.NewMemberGrant{LinkID: l.LinkID, HubUser: grantPerson, Level: "view", ScopeKind: "board", ScopeID: "team1", BoardID: "team1", Days: 7}
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"view"}`, js).Code)

	// No owner-device check wired: nothing is written, whatever the body.
	d := &ownerDevice{}
	k, kerr := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, kerr)
	d.key = k
	rec := call(h, "POST", path, d.sign(t, view, time.Now(), false), js)
	assert.Equal(t, 503, rec.Code, rec.Body.String())
	assert.Zero(t, count())

	d = wireOwnerDevice(t)
	// Unsigned, a changed signature, a signature of another device, an old time and a field the route does not take: none writes a row.
	rec = call(h, "POST", path, `{"link_id":"`+l.LinkID+`","hub_user":"`+grantPerson+`","level":"view","scope_kind":"board","label":"Ada"}`, js)
	assert.Equal(t, 403, rec.Code, rec.Body.String())
	rec = call(h, "POST", path, d.sign(t, view, time.Now(), true), js)
	assert.Equal(t, 403, rec.Code, "a bad signature: "+rec.Body.String())
	rec = call(h, "POST", path, d.sign(t, view, time.Now().Add(-time.Hour), false), js)
	assert.Equal(t, 400, rec.Code, "signed an hour ago: "+rec.Body.String())
	signedForOther := strings.Replace(d.sign(t, view, time.Now(), false), `"days":7`, `"days":6`, 1) // the text signed was for 7 days
	assert.Equal(t, 403, call(h, "POST", path, signedForOther, js).Code, "a grant changed after it was signed")
	assert.Equal(t, 400, call(h, "POST", path, strings.Replace(d.sign(t, view, time.Now(), false), `"label"`, `"board_id":"other","label"`, 1), js).Code)
	other := view
	other.LinkID = "lnk-00000000"
	assert.Equal(t, 400, call(h, "POST", path, d.sign(t, other, time.Now(), false), js).Code, "an unknown link")
	assert.Zero(t, count(), "a refused grant wrote nothing")

	// The link's cap is view: a full grant would exceed it (and is shut anyway); a view grant is fine and is for the team the path names.
	rec = call(h, "POST", path, d.sign(t, view, time.Now(), false), js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var g struct {
		GrantID  string `json:"grant_id"`
		SignedBy string `json:"signed_by"`
		ScopeID  string `json:"scope_id"`
		BoardID  string `json:"board_id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &g))
	assert.Equal(t, testOwnerKID, g.SignedBy)
	assert.Equal(t, "team1", g.ScopeID, "the scope is the team the path names, not a field")
	live, err := r.srv.boardStore.MemberGrantLive(ctx, l.LinkID, grantPerson, "board", "team1", time.Now())
	require.NoError(t, err)
	assert.Equal(t, g.GrantID, live.GrantID)

	// Full access is shut, and never on a team's route; the agent scope and files are shut too.
	full := board.NewMemberGrant{LinkID: l.LinkID, HubUser: "hub-user-cccc3333", Level: "full", ScopeKind: "computer", Days: 7}
	assert.Equal(t, 400, call(h, "POST", path, d.sign(t, full, time.Now(), false), js).Code, "full on a team's route")
	assert.Equal(t, 400, call(h, "POST", "/api/member-grants", d.sign(t, full, time.Now(), false), js).Code, "the cap of this link is view, and the gate is shut")
	assert.Equal(t, 400, call(h, "POST", "/api/member-grants", d.sign(t, view, time.Now(), false), js).Code, "a view grant on the computer's route")
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"interact"}`, js).Code)
	rec = call(h, "POST", "/api/member-grants", d.sign(t, full, time.Now(), false), js)
	assert.Equal(t, 400, rec.Code, "the full gate is shut: "+rec.Body.String())
	assert.Contains(t, rec.Body.String(), "not available yet")
	agent := board.NewMemberGrant{LinkID: l.LinkID, HubUser: "hub-user-cccc3333", Level: "view", ScopeKind: "agent", ScopeID: "a-1", BoardID: "team1", Days: 7}
	assert.Equal(t, 400, call(h, "POST", path, d.sign(t, agent, time.Now(), false), js).Code, "one agent: shut")
	board.AllowMemberGatesForTest(t)
	// Security decision 7: a full grant is signed only by a launch-mode device. An interact or view device that signs one is refused, and nothing is written.
	before := count()
	for _, m := range []string{"view", "interact"} {
		d.mode = m
		rec = call(h, "POST", "/api/member-grants", d.sign(t, full, time.Now(), false), js)
		assert.Equal(t, 403, rec.Code, m+" device signing full: "+rec.Body.String())
		assert.Equal(t, before, count(), m+" device wrote nothing")
	}
	d.mode = ""
	rec = call(h, "POST", "/api/member-grants", d.sign(t, full, time.Now(), false), js)
	require.Equal(t, 200, rec.Code, "gates open and the link allows interact: "+rec.Body.String())
	var fg struct {
		GrantID string `json:"grant_id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &fg))
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"view"}`, js).Code)
	full.HubUser = "hub-user-dddd4444"
	assert.Equal(t, 400, call(h, "POST", "/api/member-grants", d.sign(t, full, time.Now(), false), js).Code, "a link at view cannot give full")

	list := call(h, "GET", path, "", js)
	require.Equal(t, 200, list.Code)
	assert.Contains(t, list.Body.String(), g.GrantID)
	assert.NotContains(t, list.Body.String(), fg.GrantID, "a team's list has no full grant")
	all := call(h, "GET", "/api/member-grants", "", js)
	assert.Contains(t, all.Body.String(), fg.GrantID)
	assert.Contains(t, all.Body.String(), g.GrantID)

	// A team grant is ended only through its own team's path; any grant through the computer's.
	assert.Equal(t, 404, call(h, "DELETE", "/api/board/other/member-grants/"+g.GrantID, "", js).Code)
	assert.Equal(t, 404, call(h, "DELETE", path+"/"+fg.GrantID, "", js).Code, "a full grant is not on a team's list")
	assert.Equal(t, 200, call(h, "DELETE", path+"/"+g.GrantID, "", js).Code)
	assert.Equal(t, 404, call(h, "DELETE", path+"/"+g.GrantID, "", js).Code, "a second revoke finds nothing")
	assert.Equal(t, 200, call(h, "DELETE", "/api/member-grants/"+fg.GrantID, "", js).Code)
	_, err = r.srv.boardStore.MemberGrantLive(ctx, l.LinkID, grantPerson, "board", "team1", time.Now())
	assert.Error(t, err, "revoked at once")
	_ = cs
}

// Security 5b: through a Hub, at any mode and for any role, and by an agent or a script, a grant route changes nothing.
func TestNoHubAndNoAgentCanWriteAMemberGrant(t *testing.T) {
	ctx := context.Background()
	r, _, l := linkedRemote(t, &fakeRevoker{})
	h := r.srv.Router()
	_, err := r.srv.boardStore.Subscribe(ctx, "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"launch"}`, map[string]string{"Content-Type": "application/json"}).Code)
	body := `{"link_id":"` + l.LinkID + `","hub_user":"` + grantPerson + `","level":"view","label":"Ada"}`
	hub := func(role string) map[string]string {
		return map[string]string{"Content-Type": "application/json", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: l.LinkID, tunnel.ActorHeader: grantPerson, tunnel.HubRoleHeader: role, tunnel.HubUserHeader: grantPerson}
	}
	for _, role := range []string{"owner", "guide", "member", ""} {
		for _, rt := range [][2]string{{"POST", "/api/board/team1/member-grants"}, {"GET", "/api/board/team1/member-grants"}, {"DELETE", "/api/board/team1/member-grants/mg-0000000000000000"},
			{"POST", "/api/member-grants"}, {"GET", "/api/member-grants"}, {"DELETE", "/api/member-grants/mg-0000000000000000"}} {
			rec := call(h, rt[0], rt[1], body, hub(role))
			assert.Equal(t, http.StatusForbidden, rec.Code, role+" "+rt[0]+" "+rec.Body.String())
		}
	}
	// A script with a session token header (an agent) is not the person.
	rec := call(h, "POST", "/api/board/team1/member-grants", body, map[string]string{"Content-Type": "application/json", store.SessionTokenHeader: "x"})
	assert.NotEqual(t, 200, rec.Code, rec.Body.String())
	gs, err := r.srv.boardStore.ListMemberGrants(ctx, "", time.Now())
	require.NoError(t, err)
	assert.Empty(t, gs, "nothing was written")
}
