package server

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/hkdf"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20966 (design #20901 v8): a Hub's owner Allows a second Hub's request and makes or revokes its request key, signed by the owner's own device (v3). The key and the Allow code come back only sealed to the
// one-time X25519 key in the signed query. Everything here runs with the gate open for the test; the gate ships shut.

type linkRig struct {
	*relayRig
	cs *store.CloudStore
	n2 int
}

func newLinkRig(t *testing.T, open bool) *linkRig {
	t.Helper()
	if open {
		tunnel.OpenLinkRelayedForTest(t)
	}
	g := &linkRig{relayRig: newRelayRig(t)}
	store.AllowSecondLinkForTest(t)
	g.cs = store.NewCloudStore(g.d.r.db, store.NewRemoteServerStore(g.d.r.db, g.d.r.dir))
	_, err := g.d.r.db.ExecContext(context.Background(), `INSERT OR REPLACE INTO user_settings (key, value) VALUES ('cloud_max_mode', 'launch')`)
	require.NoError(t, err)
	return g
}

// browser is the browser's side: a one-time X25519 key pair and the code that opens a box.
type browser struct {
	priv *ecdh.PrivateKey
	pk   string
}

func newBrowser(t *testing.T) browser {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	require.NoError(t, err)
	return browser{priv, rb64.EncodeToString(priv.PublicKey().Bytes())}
}

func (b browser) open(t *testing.T, raw json.RawMessage, purpose, nonce, object string) (string, error) {
	t.Helper()
	var box struct {
		V     int    `json:"v"`
		EPK   string `json:"epk"`
		Nonce string `json:"nonce"`
		CT    string `json:"ct"`
	}
	require.NoError(t, json.Unmarshal(raw, &box))
	epk, _ := rb64.DecodeString(box.EPK)
	n, _ := rb64.DecodeString(box.Nonce)
	ct, _ := rb64.DecodeString(box.CT)
	pub, err := ecdh.X25519().NewPublicKey(epk)
	require.NoError(t, err)
	shared, err := b.priv.ECDH(pub)
	require.NoError(t, err)
	key := make([]byte, 32)
	_, _ = io.ReadFull(hkdf.New(sha256.New, shared, append(append([]byte{}, epk...), b.priv.PublicKey().Bytes()...), []byte("coral/link-box/1")), key)
	blk, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(blk)
	pt, err := gcm.Open(nil, n, ct, []byte("coral/link-box/1\x00"+purpose+"\x00"+nonce+"\x00"+object))
	return string(pt), err
}

// nonceN is a fresh signed nonce the test knows (the box is bound to it).
func (g *linkRig) nonceN() string {
	g.n2++
	n := make([]byte, 16)
	n[0], n[1], n[2] = byte(g.n2), byte(g.n2>>8), 77
	return rb64.EncodeToString(n)
}

func (g *linkRig) do(kind devicekey.Kind, method, target, body, nonce string, mut func(*relayReq)) *httptest.ResponseRecorder {
	q := relayReq{kind: kind, method: method, target: target, body: body, priv: g.owner, kid: g.ownK, actor: relayOwner, nonce: nonce}
	if mut != nil {
		mut(&q)
	}
	return g.signed(q)
}

func (g *linkRig) makeKey(t *testing.T, name string, b browser, mut func(*relayReq)) (*httptest.ResponseRecorder, string) {
	nonce := g.nonceN()
	return g.do(devicekey.MakeLinkKey, "POST", "/api/cloud/link-keys?box_pk="+b.pk, `{"name":"`+name+`"}`, nonce, mut), nonce
}

func (g *linkRig) pending(t *testing.T, cap string) string {
	id, _, err := g.cs.CreateLinkRequest(context.Background(), "https://hub-c.example.com", cap, "", time.Now())
	require.NoError(t, err)
	return id
}

func (g *linkRig) keys() []store.LinkKey {
	ks, err := g.cs.ListLinkKeys(context.Background())
	require.NoError(g.t, err)
	return ks
}

func TestARelayedMakeKeyReturnsOnlyABoxOnlyTheBrowserOpens(t *testing.T) {
	g := newLinkRig(t, true)
	b := newBrowser(t)
	rec, nonce := g.makeKey(t, "Hub C", b, nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.NotContains(t, rec.Body.String(), "lrk_", "the key is never in the clear")
	assert.NotRegexp(t, `"key"`, rec.Body.String())
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var out struct {
		ID   string          `json:"id"`
		Name string          `json:"name"`
		Box  json.RawMessage `json:"box"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.NotEmpty(t, out.Box)
	key, err := b.open(t, out.Box, "make-link-key", nonce, out.ID)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(key, "lrk_"), key)
	got, ok := g.cs.VerifyLinkKey(context.Background(), key, time.Now())
	require.True(t, ok, "the sealed key is a live key")
	assert.Equal(t, out.ID, got.ID)
	assert.Equal(t, "Hub C", got.Name)

	// The box opens for no other request, object or key.
	_, err = b.open(t, out.Box, "make-link-key", g.nonceN(), out.ID)
	assert.Error(t, err, "another relayed request")
	_, err = b.open(t, out.Box, "allow-link", nonce, out.ID)
	assert.Error(t, err, "another kind")
	_, err = newBrowser(t).open(t, out.Box, "make-link-key", nonce, out.ID)
	assert.Error(t, err, "another browser")

	// Attributed: the Operator-actions log and the Hub's own record both name the link, and neither holds the key.
	acts, err := g.d.r.srv.boardStore.ListActivity(context.Background(), board.ActivityFilter{Action: board.ActLinkKeyMake, Limit: 5})
	require.NoError(t, err)
	require.Len(t, acts, 1)
	assert.True(t, strings.HasPrefix(acts[0].Actor, "hub:") && acts[0].Actor != "hub:unknown", "the row is the Hub person's, never local: %q", acts[0].Actor)
	assert.Equal(t, "Hub C", acts[0].Title)
	hub, err := g.d.r.srv.boardStore.RecentHubOperatorActions(context.Background(), 20)
	require.NoError(t, err)
	seen := false
	for _, a := range hub {
		seen = seen || (a.Method == "POST" && strings.Contains(a.Path, "/api/cloud/link-keys") && a.ViaLink == testLinkID)
		assert.NotContains(t, a.Path, strings.TrimPrefix(key, "lrk_"), "the log never holds the key")
		assert.NotContains(t, a.Path, b.pk, "nor the browser's key")
	}
	assert.True(t, seen, "%+v", hub)
}

func TestNoBoxKeyNoValue(t *testing.T) {
	g := newLinkRig(t, true)
	b := newBrowser(t)
	for name, target := range map[string]string{"no query": "/api/cloud/link-keys", "a short key": "/api/cloud/link-keys?box_pk=" + b.pk[:40], "another parameter": "/api/cloud/link-keys?box_pk=" + b.pk + "&x=1",
		"the key twice": "/api/cloud/link-keys?box_pk=" + b.pk + "&box_pk=" + b.pk, "a key in the body, not the query": "/api/cloud/link-keys"} {
		rec := g.do(devicekey.MakeLinkKey, "POST", target, `{"name":"Hub C","box_pk":"`+b.pk+`"}`, "", nil)
		assert.NotEqual(t, 200, rec.Code, "%s: %s", name, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), "lrk_", name)
	}
	assert.Empty(t, g.keys(), "no key was made without a seal")
	id := g.pending(t, "interact")
	rec := g.do(devicekey.AllowLink, "POST", "/api/cloud/link-requests/"+id+"/allow", `{"cap":"view"}`, "", nil)
	assert.NotEqual(t, 200, rec.Code, rec.Body.String())
	st, _ := g.cs.LinkRequestByID(context.Background(), id, time.Now())
	assert.Equal(t, "pending", st.State, "an Allow with no seal allowed nothing and showed no code")
}

func TestTheBoxKeyIsCoveredByTheSignature(t *testing.T) {
	g := newLinkRig(t, true)
	b, other := newBrowser(t), newBrowser(t)
	rec := g.do(devicekey.MakeLinkKey, "POST", "/api/cloud/link-keys?box_pk="+other.pk, `{"name":"Hub C"}`, "", func(q *relayReq) { q.signTgt = "/api/cloud/link-keys?box_pk=" + b.pk })
	assert.NotEqual(t, 200, rec.Code, "a Hub swapping the browser's key after it was signed: %s", rec.Body.String())
	assert.Empty(t, g.keys())
}

func TestRelayedKeysAreCappedPerLinkAndRevokedOnlyByTheirLink(t *testing.T) {
	g := newLinkRig(t, true)
	b := newBrowser(t)
	var ids []string
	for i, name := range []string{"Hub A1", "Hub A2", "Hub A3"} {
		rec, _ := g.makeKey(t, name, b, nil)
		require.Equal(t, 200, rec.Code, "%d %s", i, rec.Body.String())
		var out struct{ ID string }
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		ids = append(ids, out.ID)
	}
	rec, _ := g.makeKey(t, "Hub A4", b, nil)
	assert.Equal(t, 409, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "too_many_keys_link")
	assert.Len(t, g.keys(), 3)

	local, _, err := g.cs.CreateLinkKey(context.Background(), "At the computer", time.Now())
	require.NoError(t, err)
	rev := func(id string) *httptest.ResponseRecorder {
		return g.do(devicekey.RevokeLinkKey, "DELETE", "/api/cloud/link-keys/"+id, "", "", nil)
	}
	nope := rev("lk-00000000")
	assert.Equal(t, 404, nope.Code)
	mine := rev(local)
	assert.Equal(t, 404, mine.Code, "a key made at the computer is ended at the computer")
	assert.Equal(t, nope.Body.String(), mine.Body.String(), "a Hub cannot tell one from a missing key")
	assert.Equal(t, 200, rev(ids[0]).Code)
	acts, _ := g.d.r.srv.boardStore.ListActivity(context.Background(), board.ActivityFilter{Action: board.ActLinkKeyRevoke, Limit: 5})
	require.Len(t, acts, 1)
	assert.Equal(t, "Hub A1", acts[0].Title)
	assert.True(t, strings.HasPrefix(acts[0].Actor, "hub:"), acts[0].Actor)
	rec, _ = g.makeKey(t, "Hub A4", b, nil)
	assert.Equal(t, 200, rec.Code, "a place was freed: %s", rec.Body.String())

	// Ten made in an hour, whatever is live: four are made so far; make and revoke six more, and the eleventh is refused though only two are live.
	require.Equal(t, 200, rev(ids[1]).Code)
	for i := 0; i < 6; i++ {
		rec, _ := g.makeKey(t, "Hub B"+string(rune('a'+i)), b, nil)
		if rec.Code != 200 {
			ks := g.keys()
			require.NotEmpty(t, ks)
			t.Fatalf("make %d: %d %s", i, rec.Code, rec.Body.String())
		}
		var out struct{ ID string }
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		require.Equal(t, 200, rev(out.ID).Code)
	}
	rec, _ = g.makeKey(t, "Hub too often", b, nil)
	assert.Equal(t, 429, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "link_key_rate")
}

func TestARelayedAllowSealsTheCodeCapsAtInteractAndNeedsTheSeal(t *testing.T) {
	g := newLinkRig(t, true)
	b := newBrowser(t)
	id := g.pending(t, "launch")
	allow := func(id, body string, b browser) (*httptest.ResponseRecorder, string) {
		n := g.nonceN()
		return g.do(devicekey.AllowLink, "POST", "/api/cloud/link-requests/"+id+"/allow?box_pk="+b.pk, body, n, nil), n
	}
	rec, _ := allow(id, `{"cap":"launch"}`, b)
	assert.Equal(t, 403, rec.Code, "launch is given at the computer, not through a Hub: %s", rec.Body.String())
	st, _ := g.cs.LinkRequestByID(context.Background(), id, time.Now())
	assert.Equal(t, "pending", st.State)

	rec, nonce := allow(id, `{"cap":"interact"}`, b)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.NotRegexp(t, regexp.MustCompile(`\d{8}`), rec.Body.String(), "no code in the clear")
	assert.NotContains(t, rec.Body.String(), `"code"`)
	var out struct {
		Box json.RawMessage `json:"box"`
		Cap string          `json:"cap"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, "interact", out.Cap)
	code, err := b.open(t, out.Box, "allow-link", nonce, id)
	require.NoError(t, err)
	assert.Regexp(t, `^\d{8}$`, code)
	_, err = newBrowser(t).open(t, out.Box, "allow-link", nonce, id)
	assert.Error(t, err)
	// The sealed code is the real one: the second Hub finishes with it.
	_, _, err = g.cs.FinishLinkRequest(context.Background(), id, "wrong-secret", code, time.Now())
	assert.Error(t, err, "the code alone is not enough: the Hub's poll secret too")
	// Shown once: a second Allow of the same request is refused and gives nothing.
	rec2, _ := allow(id, `{"cap":"interact"}`, b)
	assert.Equal(t, 409, rec2.Code, rec2.Body.String())
	assert.NotContains(t, rec2.Body.String(), `"box"`)
}

func TestRelayedJoinRoutesNeedTheOwnersSignedDeviceAtInteractOrMore(t *testing.T) {
	g := newLinkRig(t, true)
	b := newBrowser(t)
	viewKey, viewKid := g.ownerKeyOfMode("view")
	rec, _ := g.makeKey(t, "Hub C", b, func(q *relayReq) { q.priv, q.kid = viewKey, viewKid })
	assert.Equal(t, 403, rec.Code, "a device whose own mode is view: %s", rec.Body.String())
	rec, _ = g.makeKey(t, "Hub C", b, func(q *relayReq) { q.priv, q.kid, q.actor = g.bound, g.bndK, relayPerson })
	assert.NotEqual(t, 200, rec.Code, "a Hub person's key, not the owner's: %s", rec.Body.String())
	rec = call(g.d.r.srv.Router(), "POST", "/api/cloud/link-keys?box_pk="+b.pk, `{"name":"Hub C"}`, map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.ActorHeader: relayOwner, tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: relayOwner, "Content-Type": "application/json"})
	assert.Equal(t, "bad_form", relayCode(rec), "no signature at all: %d %s", rec.Code, rec.Body.String())
	assert.Empty(t, g.keys())
}

func TestTheRelayedJoinRoutesAreNeverTunneledWhileTheGateIsShut(t *testing.T) {
	g := newLinkRig(t, false)
	b := newBrowser(t)
	id := g.pending(t, "interact")
	for _, rec := range []*httptest.ResponseRecorder{
		g.do(devicekey.MakeLinkKey, "POST", "/api/cloud/link-keys?box_pk="+b.pk, `{"name":"Hub C"}`, "", nil),
		g.do(devicekey.AllowLink, "POST", "/api/cloud/link-requests/"+id+"/allow?box_pk="+b.pk, `{"cap":"view"}`, "", nil),
		g.do(devicekey.RevokeLinkKey, "DELETE", "/api/cloud/link-keys/lk-00000000", "", "", nil),
	} {
		assert.Equal(t, 403, rec.Code, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "hub_route_refused")
	}
	assert.Empty(t, g.keys())
	st, _ := g.cs.LinkRequestByID(context.Background(), id, time.Now())
	assert.Equal(t, "pending", st.State)
}

// ownerKeyOfMode adds another owner device at a mode (the same as the grant rig's).
func (g *linkRig) ownerKeyOfMode(mode string) (*ecdsa.PrivateKey, string) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(g.t, err)
	e, _ := priv.ECDH()
	raw := e.PublicKey().Bytes()
	kid := rb64.EncodeToString(sha(raw))
	_, err = g.d.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: kid, PK: raw, Label: "Owner phone", Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, time.Now().Add(-time.Hour))
	require.NoError(g.t, err)
	return priv, kid
}
