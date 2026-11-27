package server

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21880 (pair a browser to a connected computer): the one unsigned route answers every failure the same way, and the person's routes are not reachable through the Hub.
func TestThePairRouteRefusesEveryFailureTheSameWay(t *testing.T) {
	d := newDKRig(t)
	valid := `{"user_code":"ABCDEFGH","label":"Phone","kid":"` + rb64.EncodeToString(make([]byte, 32)) + `","pk":"AAAA","mac":"AAAA"}`
	var want string
	for i, b := range []string{"not json", "{}", valid, `{"user_code":"A","unknown":1}`, `{"user_code":"` + string(make([]byte, 5000)) + `"}`} {
		rec := d.post("/api/device-keys/pair", b, nil)
		assert.Equal(t, 403, rec.Code, "case %d", i)
		if i == 0 {
			want = rec.Body.String()
			assert.JSONEq(t, `{"error":"pairing_refused"}`, want)
		}
		assert.Equal(t, want, rec.Body.String(), "case %d: the same body whatever the cause", i)
	}
	l, err := d.ss.ListDeviceKeys(context.Background())
	require.NoError(t, err)
	assert.Len(t, l, 1, "only the rig's own signer is listed")
}

func TestThePairBrowserRoutesAreThePersonsAndNeverReachableThroughTheHub(t *testing.T) {
	d := newDKRig(t)
	h := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	for _, c := range [][2]string{{"POST", "/api/cloud/pair-browser"}, {"GET", "/api/cloud/pair-browser"}, {"DELETE", "/api/cloud/pair-browser"},
		{"POST", "/api/cloud/pair-browser/allow"}, {"POST", "/api/cloud/pair-browser/deny"}} {
		rec := call(d.r.srv.Router(), c[0], c[1], "{}", h)
		require.Equal(t, 403, rec.Code, c[0]+" "+c[1])
		assert.NotContains(t, rec.Body.String(), "#p=")
	}
}

func TestTheOwnerCertRoutesAreThePersonsAndNeverReachableThroughTheHub(t *testing.T) {
	d := newDKRig(t)
	h := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	for _, c := range [][2]string{{"GET", "/api/cloud/owner-cert"}, {"PUT", "/api/cloud/owner-cert/accept"}, {"POST", "/api/cloud/owner-cert/devices/abc/keep"},
		{"DELETE", "/api/cloud/owner-cert/devices/abc"}, {"DELETE", "/api/cloud/owner-cert/anchor"}} {
		rec := call(d.r.srv.Router(), c[0], c[1], `{"mode":"launch"}`, h)
		assert.Equal(t, 403, rec.Code, c[0]+" "+c[1]+": a Hub request is refused")
	}
	// the setting is off until the person turns it on, and it only takes a mode word
	local := map[string]string{"Content-Type": "application/json"}
	rec := call(d.r.srv.Router(), "GET", "/api/cloud/owner-cert", "", local)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"accept":"off"`)
	rec = call(d.r.srv.Router(), "PUT", "/api/cloud/owner-cert/accept", `{"mode":"root"}`, local)
	assert.Equal(t, 400, rec.Code)
	rec = call(d.r.srv.Router(), "PUT", "/api/cloud/owner-cert/accept", `{"mode":"interact"}`, local)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"accept":"interact"`)
	// Keep needs a browser this computer has seen; Remove makes a deny row for any id
	rec = call(d.r.srv.Router(), "POST", "/api/cloud/owner-cert/devices/never-seen/keep", `{}`, local)
	assert.Equal(t, 400, rec.Code)
	rec = call(d.r.srv.Router(), "DELETE", "/api/cloud/owner-cert/devices/some-kid", "", local)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"state":"removed"`)
}
