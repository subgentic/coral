package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/server/routes"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20879: a request a Hub carries on a relayed kind's route is checked by this computer. The four Coral-Device-* headers carry the signer's kid, the signature, the time and the nonce; the computer REBUILDS the
// signed text from its own state (its fingerprint, the link and Hub person its stamp names, the method and URI it received, the hash of the body it received), so nothing the Hub says can change what was signed.

const (
	relayPerson = "hub-user-aaaa1111" // the Hub person a bound key belongs to
	relayOwner  = "hub-user-bbbb2222" // the owner label pinned on the link
)

type relayRig struct {
	t            *testing.T
	d            *dkRig
	owner        *ecdsa.PrivateKey
	ownK         string
	bound        *ecdsa.PrivateKey
	bndK         string
	n            int
	sendOverride string // when set, the verb the next request is sent with (what was signed stays q.method)
}

func newRelayRig(t *testing.T) *relayRig {
	t.Helper()
	routes.ResetDeviceMessageLimits() // the failed-check counts are process-wide: not what other tests spent this minute
	r := newE2ERemote(t, "relay-20879", nil)
	ss := store.NewSessionStore(r.db)
	require.NoError(t, ss.SetSetting(context.Background(), routes.MaxModeSetting, tunnel.TierLaunch.String())) // this computer lets a Hub type into agents, so the guard is what answers
	key, err := devicekey.LoadOrCreateComputerKey(t.TempDir())
	require.NoError(t, err)
	m := cloud.New(cloud.Options{HubURL: "https://app.coralhub.dev", Store: store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.dir)), MaxMode: func() tunnel.Mode { return tunnel.TierLaunch },
		Devices: ss, ComputerKey: key, Logger: slog.New(slog.DiscardHandler)})
	r.srv.SetCloud(m)
	d := &dkRig{t: t, r: r, ss: ss, m: m, key: key}
	// The test stamp link is an added link whose owner the Operator confirmed as relayOwner.
	_, _ = r.db.ExecContext(context.Background(), `INSERT OR IGNORE INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, created_at) VALUES (?, 'https://test.invalid', 'srv_test', 'test', '', 'active', 'launch', '2026-01-01T00:00:00Z')`, testLinkID)
	_, err = r.db.ExecContext(context.Background(), `UPDATE cloud_link SET source = ?, owner_user = ?, max_mode = 'launch' WHERE link_id = ?`, store.LinkSourceAdded, relayOwner, testLinkID)
	require.NoError(t, err)
	g := &relayRig{t: t, d: d}
	g.owner, g.ownK = g.addKey(store.PairOwner, store.PairOwner)
	g.bound, g.bndK = g.addKey(testLinkID, relayPerson)
	return g
}

func (g *relayRig) addKey(link, user string) (*ecdsa.PrivateKey, string) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(g.t, err)
	e, _ := priv.ECDH()
	raw := e.PublicKey().Bytes()
	kid := rb64.EncodeToString(sha(raw))
	_, err = g.d.ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: kid, PK: raw, Label: "Phone", Mode: "launch", Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: link, HubUser: user}, time.Now().Add(-time.Hour))
	require.NoError(g.t, err)
	return priv, kid
}

// req is one relayed request as the connector hands it to the server; each field can be changed to what a bad Hub or a bad signer would do.
type relayReq struct {
	kind    devicekey.Kind
	method  string
	target  string
	body    string  // what arrives
	signed  *string // the body that was hashed when signing; nil means the one that arrives
	priv    *ecdsa.PrivateKey
	kid     string
	actor   string // the Hub person the stamp names
	signAs  string // the hub_user in the signed text; "" means actor
	link    string // the link the signed text names; "" means the arrival link
	comp    string // the computer in the signed text; "" means this one
	ts      time.Time
	nonce   string
	signTgt string // the method+URI that was signed; "" means the received one
	v2      bool   // signed with the v2 label (a message of the other form)
}

func (g *relayRig) signed(q relayReq) *httptest.ResponseRecorder {
	g.t.Helper()
	if q.actor == "" {
		q.actor = relayPerson
	}
	if q.signAs == "" {
		q.signAs = q.actor
	}
	if q.link == "" {
		q.link = testLinkID
	}
	if q.comp == "" {
		q.comp = g.d.key.Computer()
	}
	if q.ts.IsZero() {
		q.ts = time.Now()
	}
	if q.nonce == "" {
		g.n++
		n := make([]byte, 16)
		n[0], n[1], n[2] = byte(g.n), byte(g.n>>8), 9
		q.nonce = rb64.EncodeToString(n)
	}
	if q.signed == nil {
		q.signed = &q.body
	}
	signTarget := q.target
	if q.signTgt != "" {
		signTarget = q.signTgt
	}
	m := devicekey.Relayed{Kind: q.kind, KID: q.kid, Computer: q.comp, Ts: q.ts.Unix(), Nonce: q.nonce, Link: q.link, HubUser: q.signAs, Method: q.method, Path: signTarget, BodySHA256: devicekey.BodySHA256([]byte(*q.signed))}
	canon, err := m.Canonical()
	require.NoError(g.t, err)
	input := devicekey.RelayedSigningInput(q.kind, canon)
	if q.v2 {
		input = devicekey.SigningInput(devicekey.RemoveDevice, canon)
	}
	sig := signP1363(g.t, q.priv, input)
	return g.send(q, sig)
}

// signedAs signs the request as signMethod and sends it as q.method.
func (g *relayRig) signedAs(q relayReq, signMethod string) *httptest.ResponseRecorder {
	g.t.Helper()
	sent := q.method
	q.method = signMethod
	// build the signature for signMethod, then send it as the other verb
	var out *httptest.ResponseRecorder
	g.sendOverride = sent
	out = g.signed(q)
	g.sendOverride = ""
	return out
}

func (g *relayRig) send(q relayReq, sig string) *httptest.ResponseRecorder {
	h := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.ActorHeader: q.actor, "Content-Type": "application/json",
		tunnel.DeviceKeyHeader: q.kid, tunnel.DeviceSigHeader: sig, tunnel.DeviceTsHeader: fmt.Sprint(q.ts.Unix()), tunnel.DeviceNonceHeader: q.nonce}
	if q.actor == relayOwner { // what Coral Hub adds for the account this computer is linked to
		h[tunnel.HubRoleHeader] = "owner"
		h[tunnel.HubUserHeader] = relayOwner
	}
	method := q.method
	if g.sendOverride != "" {
		method = g.sendOverride
	}
	return call(g.d.r.srv.Router(), method, q.target, q.body, h)
}

// relayTarget fills a route pattern's {name} segments.
func relayTarget(pattern string) string {
	r := strings.NewReplacer("{project}", "team1", "{name}", "agent1", "{id}", strings.Repeat("a", 64))
	return r.Replace(pattern)
}

// A reply the guard itself wrote: {"error": code} with a code of the closed list.
func relayCode(rec *httptest.ResponseRecorder) string {
	var v map[string]string
	if json.Unmarshal(rec.Body.Bytes(), &v) != nil || !devicekey.InReplyCodes(v["error"]) {
		return ""
	}
	return v["error"]
}

// bodyFor is a body a kind's own rule accepts: a grant names the signer's kid, the toggle's body is empty.
func bodyFor(k devicekey.Kind, method, kid string) string {
	if k == devicekey.GrantMember && method == "POST" {
		return fmt.Sprintf(`{"signature":{"kid":%q}}`, kid)
	}
	return ""
}

// every route of every kind: a valid signed request is let through and spends its nonce (a repeat is nonce_repeat), and what is wrong with it is refused with its code before any handler.
func TestARelayedSignedRequestIsCheckedOnEveryRouteOfEveryKind(t *testing.T) {
	g := newRelayRig(t)
	n := 0
	var priv *ecdsa.PrivateKey
	var kid string
	for _, k := range devicekey.RelayedKinds {
		for _, rt := range devicekey.KindRoutes[k] {
			n++
			target := relayTarget(rt.Pattern)
			if k == devicekey.HubAutoAccept {
				target += "?allow=true"
			}
			// A new signer every third route: this computer's budget of failed checks is per signer (30 a minute), and each route here fails nine times on purpose (a computer lists at most ten keys).
			if n%3 == 1 {
				priv, kid = g.addKey(testLinkID, relayPerson)
			}
			actor := relayPerson
			base := relayReq{kind: k, method: rt.Method, target: target, body: bodyFor(k, rt.Method, kid), priv: priv, kid: kid, actor: actor}
			signedBody := base.body
			base.signed = &signedBody
			if k == devicekey.HubAutoAccept {
				// Owner-only: a person-bound key is refused as outside_pair, so this loop (bound keys) cannot show its valid case. TestARelayedOwnerSignedAutoAcceptChangesTheSwitch does.
				assert.Equal(t, tunnel.TierLaunch, tunnel.Classify(rt.Method, devicekey.RoutePath(target), "allow=true"), "the route takes its signed query")
				continue
			}
			if k == devicekey.AllowLink || k == devicekey.MakeLinkKey || k == devicekey.RevokeLinkKey || k == devicekey.DenyLink {
				// The join's three are the owner's alone, behind LinkRequestRelayedOpen (#20966): shut here, so a Hub cannot reach them; the gate-open cases are in link_relayed_20966_test.go.
				assert.Equal(t, tunnel.TierNever, tunnel.Classify(rt.Method, devicekey.RoutePath(target), ""), "%s %s", rt.Method, rt.Pattern)
				continue
			}
			if k == devicekey.GrantMember {
				// KNOWN GAPS (reported on #20879): the tunnel's route table does not list the grant routes, and (hub-auto-accept was the second gap, opened in #20882). A Hub cannot reach this one
				// at any mode, so the guard is never asked. Opening them is a change to pkg/tunnel/routes.go that Security reads first; this fails the day they open, so a signed-path test is written then.
				u := target
				query := ""
				if i := strings.IndexByte(u, '?'); i >= 0 {
					u, query = u[:i], u[i+1:]
				}
				assert.Equal(t, tunnel.TierNever, tunnel.Classify(rt.Method, u, query), "%s %s", rt.Method, rt.Pattern)
				continue
			}
			name := fmt.Sprintf("%s %s %s", k, rt.Method, rt.Pattern)

			ok := base
			ok.nonce = rb64.EncodeToString([]byte(fmt.Sprintf("ok-%013d", n))[:16])
			first := g.signed(ok)
			assert.Empty(t, relayCode(first), "%s: a valid signed request is not refused by the check: %d %s", name, first.Code, first.Body.String())
			assert.Equal(t, "nonce_repeat", relayCode(g.signed(ok)), "%s: the nonce was spent before the action", name)

			for _, c := range []struct {
				what, code string
				mut        func(q *relayReq)
			}{
				{"one changed body byte", "bad_signature", func(q *relayReq) { q.body += "x" }},
				{"another link in the signed text", "bad_signature", func(q *relayReq) { q.link = "lnk-0000ffff" }},
				{"another computer", "bad_signature", func(q *relayReq) { q.comp = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }},
				{"another hub_user in the signed text", "bad_signature", func(q *relayReq) { q.signAs = "hub-user-cccc3333" }},
				{"another path", "bad_signature", func(q *relayReq) { q.signTgt = devicekey.RoutePath(q.target) + "/x" }},
				{"another query", "bad_signature", func(q *relayReq) { q.signTgt = devicekey.RoutePath(q.target) + "?q=1" }},
				{"ts outside the window", "ts_window", func(q *relayReq) { q.ts = time.Now().Add(-time.Hour) }},
				{"an unknown kid", "bad_signature", func(q *relayReq) { q.kid = rb64.EncodeToString(sha([]byte("nobody"))) }},
				{"a v2 signature on a v3 route", "bad_signature", func(q *relayReq) { q.v2 = true }},
			} {
				q := base
				c.mut(&q)
				rec := g.signed(q)
				assert.Equal(t, c.code, relayCode(rec), "%s: %s: %d %s", name, c.what, rec.Code, rec.Body.String())
				want := http.StatusForbidden
				if c.code == "ts_window" {
					want = http.StatusBadRequest
				}
				assert.Equal(t, want, rec.Code, "%s: %s", name, c.what)
			}
		}
	}
	assert.Equal(t, 20, n, "every route of the table was visited (a route added to KindRoutes is visited too: add it here, or to the gaps)")
}

// The owner's key signs only as the owner this link confirmed (the pin), and only for the person the stamp names. (The two owner-only kinds are not reachable through the tunnel's route table yet, see the gaps in the
// test above; the owner rule itself holds for every kind, so it is tested on one a Hub reaches.)
func TestARelayedOwnerKeySignsOnlyAsThePinnedOwner(t *testing.T) {
	g := newRelayRig(t)
	roster := relayReq{kind: devicekey.GuideRoster, method: "PUT", target: "/api/board/team1/guide-roster", body: "{}"}
	q := roster
	q.priv, q.kid, q.actor = g.owner, g.ownK, relayOwner
	assert.Empty(t, relayCode(g.signed(q)), "the owner's key, as the pinned owner, is let through")

	q = roster
	q.priv, q.kid, q.actor = g.owner, g.ownK, relayPerson // the owner's key, a person who is not the pinned owner
	assert.Equal(t, "outside_pair", relayCode(g.signed(q)), "the owner's key signs only as the pinned label")

	q = roster
	q.priv, q.kid, q.actor, q.signAs = g.owner, g.ownK, relayOwner, relayPerson // the stamp names the owner, the text another person
	assert.Equal(t, "bad_signature", relayCode(g.signed(q)), "the signed person is the one the stamp names")

	_, err := g.d.r.db.ExecContext(context.Background(), `UPDATE cloud_link SET owner_user = '' WHERE link_id = ?`, testLinkID)
	require.NoError(t, err)
	q = roster
	q.priv, q.kid, q.actor = g.owner, g.ownK, relayOwner
	assert.Equal(t, "outside_pair", relayCode(g.signed(q)), "a link with no pinned owner has no owner")
}

// A key bound to one person does not sign for another, nor through another link.
func TestARelayedKeyIsHeldToItsOwnPair(t *testing.T) {
	g := newRelayRig(t)
	send := relayReq{kind: devicekey.SendToAgent, method: "POST", target: "/api/sessions/live/agent1/send", body: `{"text":"hi"}`, priv: g.bound, kid: g.bndK}
	other := send
	other.actor = "hub-user-cccc3333"
	assert.Equal(t, "outside_pair", relayCode(g.signed(other)), "another person's key signature is refused")
	_, err := g.d.r.db.ExecContext(context.Background(), `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, created_at) VALUES ('lnk-00000002', 'https://b.invalid', 'srv_b', 'b', '', 'active', 'launch', '2026-01-01T00:00:00Z')`)
	require.NoError(t, err)
	// The same key through the other link: the stamp names link 2, the key is bound to link 1.
	m := devicekey.Relayed{Kind: send.kind, KID: g.bndK, Computer: g.d.key.Computer(), Ts: time.Now().Unix(), Nonce: rb64.EncodeToString(make([]byte, 16)), Link: "lnk-00000002", HubUser: relayPerson, Method: "POST", Path: send.target, BodySHA256: devicekey.BodySHA256([]byte(send.body))}
	canon, err := m.Canonical()
	require.NoError(t, err)
	hdr := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: "lnk-00000002", tunnel.ActorHeader: relayPerson, "Content-Type": "application/json",
		tunnel.DeviceKeyHeader: g.bndK, tunnel.DeviceSigHeader: signP1363(t, g.bound, devicekey.RelayedSigningInput(send.kind, canon)), tunnel.DeviceTsHeader: fmt.Sprint(m.Ts), tunnel.DeviceNonceHeader: m.Nonce}
	assert.Equal(t, "wrong_link", relayCode(call(g.d.r.srv.Router(), "POST", send.target, send.body, hdr)))
}

// One value of each header, or nothing: a repeated Coral-Device-* header is refused; and a request on a route that is not in the table ignores them (nothing is trusted, nothing spent).
func TestRelayedHeadersAreOneEachAndOnlyOnTheTablesRoutes(t *testing.T) {
	g := newRelayRig(t)
	q := relayReq{kind: devicekey.SendToAgent, method: "POST", target: "/api/sessions/live/agent1/send", body: `{"text":"hi"}`, priv: g.bound, kid: g.bndK, actor: relayPerson, ts: time.Now(), nonce: rb64.EncodeToString(make([]byte, 16))}
	hdr := func(extra map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", q.target, strings.NewReader(q.body))
		req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		req.Header.Set(tunnel.ActorHeader, q.actor)
		for k, v := range map[string]string{tunnel.DeviceKeyHeader: q.kid, tunnel.DeviceSigHeader: "x", tunnel.DeviceTsHeader: fmt.Sprint(q.ts.Unix()), tunnel.DeviceNonceHeader: q.nonce} {
			req.Header.Set(k, v)
		}
		for k, v := range extra {
			req.Header.Add(k, v)
		}
		rec := httptest.NewRecorder()
		g.d.r.srv.Router().ServeHTTP(rec, req)
		return rec
	}
	assert.Equal(t, "bad_form", relayCode(hdr(map[string]string{tunnel.DeviceSigHeader: "y"})), "a repeated header is refused")
	assert.Equal(t, "bad_form", relayCode(hdr(map[string]string{tunnel.DeviceNonceHeader: q.nonce})), "a repeated header is refused, even the same value")

	// A route that is not in the table: the headers are ignored, whatever they say.
	req := httptest.NewRequest("GET", "/api/health", nil)
	req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000"
	req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
	req.Header.Set(tunnel.DeviceKeyHeader, "zzz")
	rec := httptest.NewRecorder()
	g.d.r.srv.Router().ServeHTTP(rec, req)
	assert.Empty(t, relayCode(rec))
	assert.Equal(t, 200, rec.Code)
}

// A request that did not come through the connector carries no Hub person and no link: its Coral-Device-* headers are not read.
func TestALocalRequestsRelayedHeadersAreNotRead(t *testing.T) {
	g := newRelayRig(t)
	rec := call(g.d.r.srv.Router(), "POST", "/api/sessions/live/agent1/send", `{"text":"hi"}`, map[string]string{"Content-Type": "application/json",
		tunnel.DeviceKeyHeader: g.bndK, tunnel.DeviceSigHeader: "x", tunnel.DeviceTsHeader: "1", tunnel.DeviceNonceHeader: "y"})
	assert.Empty(t, relayCode(rec), rec.Body.String())
}

// QA's two additions on #20879: the method is part of what was signed, and a v3 signature is not a v2 message.
func TestARelayedSignatureIsForItsMethodAndNotForAV2Route(t *testing.T) {
	g := newRelayRig(t)
	// trust-preview has both a PUT and a DELETE in the table: a PUT signature sent as a DELETE (the Hub changing the verb) is refused, and the PUT itself passes.
	put := relayReq{kind: devicekey.TrustPreview, method: "PUT", target: "/api/artifacts/" + strings.Repeat("a", 64) + "/trust-preview", priv: g.bound, kid: g.bndK, actor: relayPerson}
	rec := g.signed(put)
	assert.Empty(t, relayCode(rec), "the PUT as signed is not refused by the check: %d %s", rec.Code, rec.Body.String())
	swapped := put
	swapped.method = "DELETE"
	swapped.signTgt = put.target
	swapped.nonce = "" // a new nonce: the refusal is the method, not a repeat
	rb := g.signedAs(swapped, "PUT")
	assert.Equal(t, "bad_signature", relayCode(rb), "a PUT signature sent as a DELETE: %d %s", rb.Code, rb.Body.String())

	// A v3 signature on a route of the v2 form (a device removes a key: its own body carries the signature): the relayed check does not read it, and the route refuses it by its own rule; the key stays.
	target := "/api/cloud/devices/" + g.bndK
	v3 := relayReq{kind: devicekey.SendToAgent, method: "DELETE", target: target, priv: g.bound, kid: g.bndK, actor: relayPerson}
	rv := g.signed(v3)
	assert.Empty(t, relayCode(rv), "the relayed check does not claim a route outside its table: %d %s", rv.Code, rv.Body.String())
	assert.NotEqual(t, 200, rv.Code, "a v3 signature does not remove a key: %s", rv.Body.String())
	_, err := g.d.ss.ActiveDeviceKey(context.Background(), g.bndK, time.Now())
	assert.NoError(t, err, "the key is still active")
}

// #20882: the owner's own key signs hub-auto-accept with ?allow=true|false; the Hub's carrying it reaches the setter, which records the change. A key bound to a person, a query the table refuses, a signed
// query that is not the one sent, and a body that disagrees with the query never change the switch.
func TestARelayedOwnerSignedAutoAcceptChangesTheSwitch(t *testing.T) {
	g := newRelayRig(t)
	ctx := context.Background()
	allowed := func() bool {
		s, err := g.d.ss.GetSettings(ctx)
		require.NoError(t, err)
		return routes.HubAutoAcceptAllowed(s)
	}
	send := func(priv *ecdsa.PrivateKey, kid, actor, target, body string, mut func(*relayReq)) *httptest.ResponseRecorder {
		q := relayReq{kind: devicekey.HubAutoAccept, method: "POST", target: target, body: body, priv: priv, kid: kid, actor: actor}
		if mut != nil {
			mut(&q)
		}
		return g.signed(q)
	}
	require.True(t, allowed(), "on by default")

	rec := send(g.owner, g.ownK, relayOwner, "/api/hub-auto-accept?allow=false", `{"allow":false}`, nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.False(t, allowed())
	assert.Equal(t, 1, relayedActions(t, g), "the change is recorded in the Operator-actions log")
	s, err := g.d.ss.GetSettings(ctx)
	require.NoError(t, err)
	assert.Contains(t, s[setreg.HubAutoAcceptChanged], relayOwner, "and the who-and-when record beside the switch names the owner")

	rec = send(g.owner, g.ownK, relayOwner, "/api/hub-auto-accept?allow=true", `{"allow":true}`, nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.True(t, allowed(), "turned on by the same rule, the same key")
	assert.Equal(t, 2, relayedActions(t, g))

	for _, c := range []struct {
		name   string
		priv   *ecdsa.PrivateKey
		kid    string
		actor  string
		target string
		body   string
		mut    func(*relayReq)
		status int
		code   string
	}{
		{"a key bound to a person", g.bound, g.bndK, relayPerson, "/api/hub-auto-accept?allow=false", `{"allow":false}`, nil, 0, "outside_pair"},
		{"the owner key for another person", g.owner, g.ownK, relayPerson, "/api/hub-auto-accept?allow=false", `{"allow":false}`, nil, 0, "outside_pair"},
		{"a query the table refuses", g.owner, g.ownK, relayOwner, "/api/hub-auto-accept?allow=False", `{"allow":false}`, nil, 403, ""},
		{"an extra key", g.owner, g.ownK, relayOwner, "/api/hub-auto-accept?allow=false&x=1", `{"allow":false}`, nil, 403, ""},
		{"a repeated key", g.owner, g.ownK, relayOwner, "/api/hub-auto-accept?allow=false&allow=false", `{"allow":false}`, nil, 403, ""},
		{"the signed query is not the one sent", g.owner, g.ownK, relayOwner, "/api/hub-auto-accept?allow=false", `{"allow":false}`, func(q *relayReq) { q.signTgt = "/api/hub-auto-accept?allow=true" }, 0, "bad_signature"},
		{"a body that disagrees with the signed query", g.owner, g.ownK, relayOwner, "/api/hub-auto-accept?allow=false", `{"allow":true}`, nil, 0, "wrong_request"},
	} {
		rec := send(c.priv, c.kid, c.actor, c.target, c.body, c.mut)
		if c.code != "" {
			assert.Equal(t, c.code, relayCode(rec), "%s: %d %s", c.name, rec.Code, rec.Body.String())
		} else {
			assert.Equal(t, c.status, rec.Code, "%s: %s", c.name, rec.Body.String())
		}
		assert.True(t, allowed(), "%s: the switch did not change", c.name)
		assert.Equal(t, 2, relayedActions(t, g), "%s: nothing was recorded", c.name)
	}
}

func relayedActions(t *testing.T, g *relayRig) int {
	t.Helper()
	rows, err := g.d.r.srv.boardStore.RecentHubOperatorActions(context.Background(), 50)
	require.NoError(t, err)
	return len(rows)
}
