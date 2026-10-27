package cloud

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #9084 (coral-hub's defect): the Hub's goal-links SERVICE read is never a user's route, so the user table refused it and the Guard answered 403 for a read the connector had allowed. An authentically
// service-stamped request is judged by the service table; a user's request, a forged stamp and a half stamp are still judged by the user table, and the 403 carries a closed code.

func guardServer(t *testing.T) http.Handler {
	t.Helper()
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	return Guard(func() tunnel.Mode { return tunnel.TierView })(next)
}

func serveGuard(h http.Handler, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func serviceHeaders() map[string]string {
	return map[string]string{tunnel.ViaHeader: ViaSecret(), tunnel.HubServiceHeader: "1", tunnel.HubAskServerHeader: "srv", tunnel.HubAskBoardHeader: "alpha"}
}

func TestGuardLetsTheHubsAuthenticServiceStreamReachItsServiceRoute(t *testing.T) {
	h := guardServer(t)
	rec := serveGuard(h, http.MethodGet, "/api/goal-links?request_id=abc", serviceHeaders())
	assert.Equal(t, http.StatusNoContent, rec.Code, "the service stream reaches the handler: %s", rec.Body.String())
	hdr := serviceHeaders()
	delete(hdr, tunnel.HubAskServerHeader)
	assert.Equal(t, http.StatusNoContent, serveGuard(h, http.MethodGet, "/api/goal-links?request_id=abc", hdr).Code, "a board on this computer has no server")
}

func TestGuardStillRefusesEveryoneElseOnTheServiceRouteWithAClosedCode(t *testing.T) {
	h := guardServer(t)
	const target = "/api/goal-links?request_id=abc"
	for name, hdr := range map[string]map[string]string{
		"a user's tunneled stream (the connector's stamp, no service flag)": {tunnel.ViaHeader: ViaSecret()},
		"a user's stream whose request carried the service headers":         {tunnel.ViaHeader: "1", tunnel.HubServiceHeader: "1", tunnel.HubAskBoardHeader: "alpha"},
		"a forged via stamp with every service header":                      {tunnel.ViaHeader: "not-the-secret", tunnel.HubServiceHeader: "1", tunnel.HubAskServerHeader: "srv", tunnel.HubAskBoardHeader: "alpha"},
		"the secret and the flag but no asker (a half stamp)":               {tunnel.ViaHeader: ViaSecret(), tunnel.HubServiceHeader: "1"},
		"the secret and an asker with a control character":                  {tunnel.ViaHeader: ViaSecret(), tunnel.HubServiceHeader: "1", tunnel.HubAskBoardHeader: "al\x07pha"},
		"the secret, an asker and the flag set to something else":           {tunnel.ViaHeader: ViaSecret(), tunnel.HubServiceHeader: "true", tunnel.HubAskBoardHeader: "alpha"},
	} {
		rec := serveGuard(h, http.MethodGet, target, hdr)
		require.Equal(t, http.StatusForbidden, rec.Code, name)
		var body map[string]string
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), name)
		assert.Equal(t, GuardRefusedCode, body["code"], name)
		assert.Contains(t, body["error"], "not available through the Coral Hub", name)
	}
}

// The service table is the service stream's alone: a stamped request for any other route that the user table refuses is refused too, and a service route's own query rules and methods hold.
func TestGuardServiceStampOpensNothingButTheServiceRoutes(t *testing.T) {
	h := guardServer(t)
	for _, c := range []struct{ method, target string }{
		{http.MethodGet, "/api/settings"},
		{http.MethodPut, "/api/settings"},
		{http.MethodPost, "/api/goal-links?request_id=abc"},
		{http.MethodGet, "/api/goal-links?request_id=abc&q=x"},
		{http.MethodGet, "/api/system/api-key"},
		{http.MethodPost, "/api/cloud/connect"},
	} {
		rec := serveGuard(h, c.method, c.target, serviceHeaders())
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s %s", c.method, c.target)
	}
	// A user route a user may read is not changed by a service stamp: it still passes.
	assert.Equal(t, http.StatusNoContent, serveGuard(h, http.MethodGet, "/api/health", serviceHeaders()).Code)
	// And a request with no via header is never the Guard's.
	assert.Equal(t, http.StatusNoContent, serveGuard(h, http.MethodGet, "/api/goal-links?request_id=abc", nil).Code, "locally the handler decides (it answers 403 service_only)")
}

func TestServiceAskerNeedsTheSecretTheFlagAndAWellFormedAsker(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	for k, v := range serviceHeaders() {
		r.Header.Set(k, v)
	}
	a, ok := ServiceAsker(r)
	require.True(t, ok)
	assert.Equal(t, tunnel.HubAsker{Server: "srv", Board: "alpha"}, a)
	r.Header.Set(tunnel.ViaHeader, "1")
	_, ok = ServiceAsker(r)
	assert.False(t, ok, "a via stamp that is not this process's secret")
}
