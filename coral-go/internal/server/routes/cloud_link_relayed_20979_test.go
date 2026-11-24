package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20979 (Security on #20966): every refusal in relayedLink and in the relayed guard is asked ON ITS OWN. The server tests go through both layers, so removing one check leaves the other refusing and no test turns red;
// these call relayedLink and the guard directly, so each check has a test that fails when only that check is removed. The mutation list that proves it is in the task's result.

const (
	rlOwner  = "hub-user-0000beef"
	rlPerson = "hub-user-1234abcd"
	rlLink   = "link-aaaa1111"
	rlBox    = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

// rlCall is one request into relayedLink: everything the guard would have verified, each field changeable.
type rlCall struct {
	kind    devicekey.Kind
	method  string
	target  string
	body    string
	signed  bool
	tunnel  bool
	link    string // the link the request arrived through
	hubUser string // the Hub person it arrived with
	role    string // the connector's role stamp
	m       devicekey.Relayed
	mode    string // the signing device's mode
	owner   bool   // the signing device is the owner's
	found   bool   // the signing device is on the list
	body2   string // the body that is actually read, when it is not the signed one
}

func rlBase(kind devicekey.Kind) rlCall {
	c := rlCall{kind: kind, signed: true, tunnel: true, link: rlLink, hubUser: rlOwner, role: tunnel.HubRoleOwner, mode: "interact", owner: true, found: true, body: "{}"}
	switch kind {
	case devicekey.AllowLink:
		c.method, c.target = "POST", "/api/cloud/link-requests/lr-1/allow?box_pk="+rlBox
	case devicekey.MakeLinkKey:
		c.method, c.target = "POST", "/api/cloud/link-keys?box_pk="+rlBox
	case devicekey.RevokeLinkKey:
		c.method, c.target = "DELETE", "/api/cloud/link-keys/lk-aaaa1111"
	case devicekey.DenyLink:
		c.method, c.target = "POST", "/api/cloud/link-requests/lr-1/deny"
	}
	c.m = devicekey.Relayed{Kind: kind, KID: "kid-1", Link: rlLink, HubUser: rlOwner, Method: c.method, Path: c.target, BodySHA256: devicekey.BodySHA256([]byte(c.body))}
	return c
}

func (c rlCall) run(t *testing.T) (*httptest.ResponseRecorder, bool) {
	t.Helper()
	oldSigner, oldLabel := relayedSignerMode, hubOwnerLabel
	relayedSignerMode = func(context.Context, string) (string, bool, bool) { return c.mode, c.owner, c.found }
	hubOwnerLabel = func(context.Context) (string, error) { return rlOwner, nil }
	t.Cleanup(func() { relayedSignerMode, hubOwnerLabel = oldSigner, oldLabel })
	read := c.body
	if c.body2 != "" {
		read = c.body2
	}
	r := httptest.NewRequest(c.method, c.target, strings.NewReader(read))
	if c.tunnel {
		stamp(r)
		r.Header.Set(tunnel.HubUserHeader, c.hubUser)
		if c.role != "" {
			r.Header.Set(tunnel.HubRoleHeader, c.role)
		}
	}
	ctx := r.Context()
	if c.tunnel {
		ctx = cloud.WithVia(ctx, cloud.Via{LinkID: c.link, HubUser: c.hubUser})
	}
	if c.signed {
		ctx = devicekey.WithRelayed(ctx, c.m)
	}
	rec := httptest.NewRecorder()
	_, ok := relayedLink(rec, r.WithContext(ctx), c.kind)
	return rec, ok
}

var rlKinds = []devicekey.Kind{devicekey.AllowLink, devicekey.MakeLinkKey, devicekey.RevokeLinkKey, devicekey.DenyLink}

func TestRelayedLinkAcceptsAFullyVerifiedRequestOfEachKind(t *testing.T) {
	tunnel.OpenLinkRelayedForTest(t)
	for _, k := range rlKinds {
		rec, ok := rlBase(k).run(t)
		assert.True(t, ok, "%s: %d %s", k, rec.Code, rec.Body.String())
	}
}

// Each refusal on its own, for every kind: the mutation that removes only that check turns one of these red.
func TestRelayedLinkRefusesEachCheckOnItsOwn(t *testing.T) {
	tunnel.OpenLinkRelayedForTest(t)
	cases := []struct {
		why string
		mut func(*rlCall)
	}{
		{"the gate is shut", nil}, // handled below: the gate is opened by run(), so this one is its own test
		{"not through a Hub", func(c *rlCall) { c.tunnel = false }},
		{"no link on the request", func(c *rlCall) { c.link = "" }},
		{"no verified signature", func(c *rlCall) { c.signed = false }},
		{"a verified message of another kind", func(c *rlCall) { c.m.Kind = devicekey.GrantMember }},
		{"signed for another method", func(c *rlCall) { c.m.Method = "PUT" }},
		{"signed for another path", func(c *rlCall) { c.m.Path = "/api/cloud/other" }},
		{"signed for another link", func(c *rlCall) { c.m.Link = "link-bbbb2222" }},
		{"signed for another Hub person", func(c *rlCall) { c.m.HubUser = rlPerson }},
		{"a body that is not the one hashed", func(c *rlCall) { c.body2 = `{"cap":"interact"}` }},
		{"a body over the cap", func(c *rlCall) {
			c.body2 = strings.Repeat("a", relayedLinkBodyMax+1)
			c.m.BodySHA256 = devicekey.BodySHA256([]byte(c.body2))
		}},
		{"a Hub person who is not the owner", func(c *rlCall) { c.role = "member"; c.hubUser = rlPerson; c.m.HubUser = rlPerson }},
		{"a signing device that is not the owner's", func(c *rlCall) { c.owner = false }},
		{"a signing device not on the list", func(c *rlCall) { c.found = false }},
		{"a signing device below interact", func(c *rlCall) { c.mode = "view" }},
		{"a signing device with a mode this code does not know", func(c *rlCall) { c.mode = "root" }},
	}
	for _, k := range rlKinds {
		for _, tc := range cases {
			if tc.mut == nil {
				continue
			}
			c := rlBase(k)
			tc.mut(&c)
			rec, ok := c.run(t)
			assert.False(t, ok, "%s: %s", k, tc.why)
			assert.Contains(t, []int{http.StatusForbidden, http.StatusBadRequest}, rec.Code, "%s: %s: %s", k, tc.why, rec.Body.String())
		}
	}
	// The browser's key: only Allow and Make sign one; without it the request is refused before anything is made.
	for _, k := range []devicekey.Kind{devicekey.AllowLink, devicekey.MakeLinkKey} {
		c := rlBase(k)
		c.target = strings.Split(c.target, "?")[0]
		c.m.Path = c.target
		rec, ok := c.run(t)
		assert.False(t, ok, "%s without the browser's key", k)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	}
}

// QA2's SHOULD on #20966: the owner check inside relayedLink is asked by itself. The signature, the link and the device are all the owner's here; only the connector's role stamp says the Hub person is not the owner.
func TestOnlyTheOwnerCheckInsideRelayedLinkRefusesANonOwnerHubPerson(t *testing.T) {
	tunnel.OpenLinkRelayedForTest(t)
	for _, k := range rlKinds {
		c := rlBase(k)
		c.role = "member"
		rec, ok := c.run(t)
		assert.False(t, ok, string(k))
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s: %s", k, rec.Body.String())
		c = rlBase(k)
		c.role = ""
		_, ok = c.run(t)
		assert.False(t, ok, "%s: no role stamp at all", k)
	}
}

func TestRelayedLinkIsShutWhileTheGateIsShut(t *testing.T) {
	old, oldLabel := relayedSignerMode, hubOwnerLabel
	relayedSignerMode = func(context.Context, string) (string, bool, bool) { return "interact", true, true }
	hubOwnerLabel = func(context.Context) (string, error) { return rlOwner, nil }
	t.Cleanup(func() { relayedSignerMode, hubOwnerLabel = old, oldLabel })
	for _, k := range rlKinds {
		c := rlBase(k)
		r := httptest.NewRequest(c.method, c.target, strings.NewReader(c.body))
		stamp(r)
		r.Header.Set(tunnel.HubUserHeader, rlOwner)
		r.Header.Set(tunnel.HubRoleHeader, tunnel.HubRoleOwner)
		ctx := devicekey.WithRelayed(cloud.WithVia(r.Context(), cloud.Via{LinkID: rlLink, HubUser: rlOwner}), c.m)
		rec := httptest.NewRecorder()
		_, ok := relayedLink(rec, r.WithContext(ctx), k)
		assert.False(t, ok, "%s with the gate shut", k)
		assert.Equal(t, http.StatusForbidden, rec.Code)
	}
	oldNil := relayedSignerMode
	relayedSignerMode = nil
	t.Cleanup(func() { relayedSignerMode = oldNil })
	c := rlBase(devicekey.DenyLink)
	relayedSignerMode = nil
	tunnel.OpenLinkRelayedForTest(t)
	r := httptest.NewRequest(c.method, c.target, strings.NewReader(c.body))
	rec := httptest.NewRecorder()
	_, ok := relayedLink(rec, r, devicekey.DenyLink)
	assert.False(t, ok, "no signer lookup wired")
}

// isVerifiedRelayedGrant is what lets the identity guard pass a verified relayed request without an Operator identity: exactly the five kinds, and only with a verified message.
func TestOnlyTheVerifiedRelayedKindsPassTheIdentityGuardWithoutAnOperator(t *testing.T) {
	for _, k := range []devicekey.Kind{devicekey.GrantMember, devicekey.AllowLink, devicekey.MakeLinkKey, devicekey.RevokeLinkKey, devicekey.DenyLink} {
		r := httptest.NewRequest("POST", "/x", nil)
		assert.False(t, isVerifiedRelayedGrant(r), "%s with no verified message", k)
		r = r.WithContext(devicekey.WithRelayed(r.Context(), devicekey.Relayed{Kind: k}))
		assert.True(t, isVerifiedRelayedGrant(r), string(k))
	}
	r := httptest.NewRequest("POST", "/x", nil)
	r = r.WithContext(devicekey.WithRelayed(r.Context(), devicekey.Relayed{Kind: devicekey.BoardPost}))
	assert.False(t, isVerifiedRelayedGrant(r), "another signed kind is not a grant")
}

// noStore is a device list that knows no key and fails the test on any other call: the guard's own refusals come before the verifier is asked anything else.
type noStore struct{ devicekey.Store }

func (noStore) ActiveDeviceKey(context.Context, string, time.Time) (store.DeviceKey, error) {
	return store.DeviceKey{}, errors.New("no such key")
}

func guardFor(t *testing.T, link string, v func() *devicekey.Verifier, mut func(*http.Request)) (rec *httptest.ResponseRecorder, reached bool) {
	t.Helper()
	g := RelayedGuard(v, func(context.Context) (string, error) { return rlOwner, nil })
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })
	c := rlBase(devicekey.AllowLink)
	r := httptest.NewRequest(c.method, c.target, strings.NewReader("{}"))
	stamp(r)
	r = r.WithContext(cloud.WithVia(r.Context(), cloud.Via{LinkID: link, HubUser: rlOwner}))
	for _, h := range tunnel.DeviceHeaders {
		r.Header.Set(h, "x")
	}
	if mut != nil {
		mut(r)
	}
	rec = httptest.NewRecorder()
	g(next).ServeHTTP(rec, r)
	return rec, reached
}

func TestTheGuardRefusesEachKindWithNoSignatureAtAll(t *testing.T) {
	for _, k := range rlKinds {
		c := rlBase(k)
		g := RelayedGuard(func() *devicekey.Verifier { return &devicekey.Verifier{Store: noStore{}} }, func(context.Context) (string, error) { return rlOwner, nil })
		reached := false
		r := httptest.NewRequest(c.method, c.target, strings.NewReader("{}"))
		stamp(r)
		r = r.WithContext(cloud.WithVia(r.Context(), cloud.Via{LinkID: rlLink, HubUser: rlOwner}))
		rec := httptest.NewRecorder()
		g(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true })).ServeHTTP(rec, r)
		assert.False(t, reached, "%s unsigned must not reach the handler", k)
		assert.Contains(t, rec.Body.String(), "bad_form", string(k))
	}
}

func TestTheGuardRefusesWhenTheHeadersAreNotWhole(t *testing.T) {
	rec, reached := guardFor(t, rlLink, func() *devicekey.Verifier { return &devicekey.Verifier{Store: noStore{}} }, func(r *http.Request) { r.Header.Del(tunnel.DeviceHeaders[0]) })
	assert.False(t, reached)
	assert.Contains(t, rec.Body.String(), "bad_form")
}

func TestTheGuardRefusesWhenThereIsNoVerifier(t *testing.T) {
	rec, reached := guardFor(t, rlLink, func() *devicekey.Verifier { return nil }, nil)
	assert.False(t, reached)
	assert.NotEqual(t, http.StatusOK, rec.Code)
}

func TestTheGuardRefusesASignerOverItsOwnBudget(t *testing.T) {
	const link = "link-budget0"
	key := link + "|unknown"
	for i := 0; i < deviceMsgPerMin; i++ {
		deviceMsgLimiter.failed(key, time.Now())
	}
	rec, reached := guardFor(t, link, func() *devicekey.Verifier { return &devicekey.Verifier{Store: noStore{}} }, nil)
	assert.False(t, reached, "the budget is spent")
	assert.NotContains(t, rec.Body.String(), "bad_form", "refused for the budget, before the headers were read")
	assert.NotEqual(t, http.StatusOK, rec.Code)
}

func TestTheGuardRefusesABodyOverTheRelayedCapBeforeVerifying(t *testing.T) {
	rec, reached := guardFor(t, rlLink, func() *devicekey.Verifier { return &devicekey.Verifier{Store: noStore{}} }, func(r *http.Request) {
		r.Body = readerOf(strings.Repeat("a", devicekey.RelayedBodyMax+10))
	})
	assert.False(t, reached)
	assert.Contains(t, rec.Body.String(), "body_too_large")
}

func readerOf(s string) *nopCloser { return &nopCloser{strings.NewReader(s)} }

type nopCloser struct{ *strings.Reader }

func (nopCloser) Close() error { return nil }
