package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

const (
	linkKnown = "lnk-0123abcd"
	linkStale = "lnk-ffffffff"
)

func knownLinks(_ context.Context, id string) bool { return id == linkKnown }

// serve runs one request through LinkStamp and reports the status and the pair the handler saw.
func serve(t *testing.T, fn AllowFunc, set func(h http.Header)) (code int, seen Via, saw bool, hdr http.Header) {
	t.Helper()
	h := LinkStamp(knownLinks, fn)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, saw = ViaFrom(r.Context())
		hdr = r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/board/t/messages", nil)
	set(req.Header)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, seen, saw, hdr
}

func authentic(h http.Header) { h.Set(tunnel.ViaHeader, ViaSecret()) }

// #20312: the connector's own request, with a known link, carries the pair to the handler.
func TestTheConnectorsRequestCarriesItsLinkAndPerson(t *testing.T) {
	code, v, saw, _ := serve(t, AllowAll, func(h http.Header) {
		authentic(h)
		h.Set(tunnel.LinkHeader, linkKnown)
		h.Set(tunnel.ActorHeader, "hub-user-1234abcd")
	})
	assert.Equal(t, http.StatusNoContent, code)
	require.True(t, saw)
	assert.Equal(t, Via{LinkID: linkKnown, HubUser: "hub-user-1234abcd"}, v)

	// No person named (a read, or a Hub that did not say): the link alone.
	_, v, saw, _ = serve(t, AllowAll, func(h http.Header) { authentic(h); h.Set(tunnel.LinkHeader, linkKnown) })
	require.True(t, saw)
	assert.Equal(t, Via{LinkID: linkKnown}, v)

	// A label that is not one is no person, never a name the Operator could be mistaken for.
	_, v, _, _ = serve(t, AllowAll, func(h http.Header) {
		authentic(h)
		h.Set(tunnel.LinkHeader, linkKnown)
		h.Set(tunnel.ActorHeader, "Operator")
	})
	assert.Equal(t, Via{LinkID: linkKnown}, v)
}

// Fail closed: the connector's request with no link, a malformed one, a stale one or two is refused; nothing reaches the handler.
func TestAConnectorRequestWithNoKnownLinkIsRefused(t *testing.T) {
	for name, set := range map[string]func(h http.Header){
		"none":       func(h http.Header) {},
		"malformed":  func(h http.Header) { h.Set(tunnel.LinkHeader, "lnk-XYZ") },
		"upper case": func(h http.Header) { h.Set(tunnel.LinkHeader, "lnk-0123ABCD") },
		"stale":      func(h http.Header) { h.Set(tunnel.LinkHeader, linkStale) },
		"two values": func(h http.Header) { h.Add(tunnel.LinkHeader, linkKnown); h.Add(tunnel.LinkHeader, linkKnown) },
		"two actors": func(h http.Header) {
			h.Set(tunnel.LinkHeader, linkKnown)
			h.Add(tunnel.ActorHeader, "hub-user-1234abcd")
			h.Add(tunnel.ActorHeader, "hub-user-1234abcd")
		},
		"empty value": func(h http.Header) { h.Set(tunnel.LinkHeader, "") },
	} {
		code, _, saw, _ := serve(t, AllowAll, func(h http.Header) { authentic(h); set(h) })
		assert.Equal(t, http.StatusForbidden, code, name)
		assert.False(t, saw, name)
	}
}

// A request that is not the connector's (no stamp, or a forged one) is believed in nothing: the two headers are removed and it goes on as a local request.
func TestARequestThatIsNotTheConnectorsIsBelievedInNothing(t *testing.T) {
	for name, set := range map[string]func(h http.Header){
		"a local program": func(h http.Header) {},
		"a forged stamp":  func(h http.Header) { h.Set(tunnel.ViaHeader, "not-the-secret") },
	} {
		code, _, saw, hdr := serve(t, AllowAll, func(h http.Header) {
			set(h)
			h.Set(tunnel.LinkHeader, linkKnown)
			h.Set(tunnel.ActorHeader, "hub-user-1234abcd")
		})
		assert.Equal(t, http.StatusNoContent, code, name)
		assert.False(t, saw, name+": no pair")
		assert.Empty(t, hdr.Values(tunnel.LinkHeader), name)
		assert.Empty(t, hdr.Values(tunnel.ActorHeader), name)
	}
}

// Allow is the one check point and fails closed: a no, a panic and a missing function all refuse.
func TestAllowFailsClosed(t *testing.T) {
	good := func(h http.Header) { authentic(h); h.Set(tunnel.LinkHeader, linkKnown) }
	var gotAction, gotResource string
	spy := func(_ context.Context, v Via, action, resource string) (bool, string) {
		gotAction, gotResource = action, resource
		return true, ""
	}
	code, _, _, _ := serve(t, spy, good)
	assert.Equal(t, http.StatusNoContent, code)
	assert.Equal(t, "POST", gotAction)
	assert.Equal(t, "/api/board/t/messages", gotResource)

	code, _, saw, _ := serve(t, func(context.Context, Via, string, string) (bool, string) { return false, "no" }, good)
	assert.Equal(t, http.StatusForbidden, code)
	assert.False(t, saw)
	code, _, saw, _ = serve(t, func(context.Context, Via, string, string) (bool, string) { panic("boom") }, good)
	assert.Equal(t, http.StatusForbidden, code, "a panic denies")
	assert.False(t, saw)
	code, _, _, _ = serve(t, nil, good)
	assert.Equal(t, http.StatusForbidden, code, "no function denies")
}
