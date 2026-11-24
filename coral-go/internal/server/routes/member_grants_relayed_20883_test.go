package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20883, Security's condition 9: the guard and the handler each refuse alone. Here the guard is gone: a request the connector stamped, that no guard verified, is refused by the handler; and one that carries a
// verified message is still refused when it is of another kind, method, URI, link or body, or while the gate is shut.
func TestTheGrantHandlerRefusesAHubRequestTheGuardDidNotVerify(t *testing.T) {
	tunnel.OpenMemberRelayedForTest(t)
	body := `{"link_id":"lnk-00000001"}`
	mk := func(method, target string, m *devicekey.Relayed) *http.Request {
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		ctx := cloud.WithVia(r.Context(), cloud.Via{LinkID: "lnk-00000001", HubUser: "hub-user-bbbb2222"})
		if m != nil {
			ctx = devicekey.WithRelayed(ctx, *m)
		}
		return r.WithContext(ctx)
	}
	good := func() *devicekey.Relayed {
		return &devicekey.Relayed{Kind: devicekey.GrantMember, Method: "POST", Path: "/api/member-grants", Link: "lnk-00000001", HubUser: "hub-user-bbbb2222", BodySHA256: devicekey.BodySHA256([]byte(body))}
	}
	run := func(r *http.Request) bool {
		rec := httptest.NewRecorder()
		return memberOperatorOnly(rec, r)
	}
	assert.True(t, run(mk("POST", "/api/member-grants", good())), "a verified message of this request passes the check")
	assert.False(t, run(mk("POST", "/api/member-grants", nil)), "no verified message: refused by the handler alone")
	for name, mut := range map[string]func(*devicekey.Relayed){
		"another kind":   func(m *devicekey.Relayed) { m.Kind = devicekey.SendToAgent },
		"another method": func(m *devicekey.Relayed) { m.Method = "DELETE" },
		"another URI":    func(m *devicekey.Relayed) { m.Path = "/api/member-grants?x=1" },
		"another link":   func(m *devicekey.Relayed) { m.Link = "lnk-00000002" },
		"another person": func(m *devicekey.Relayed) { m.HubUser = "hub-user-aaaa1111" },
		"another body":   func(m *devicekey.Relayed) { m.BodySHA256 = devicekey.BodySHA256([]byte("x")) },
	} {
		m := good()
		mut(m)
		assert.False(t, run(mk("POST", "/api/member-grants", m)), name)
	}
	assert.False(t, run(mk("GET", "/api/member-grants", func() *devicekey.Relayed { m := good(); m.Method = "GET"; return m }())), "a Hub never reads the lists")
	_ = context.Background()
}

func TestTheGrantHandlerRefusesAVerifiedRequestWhileTheGateIsShut(t *testing.T) {
	body := `{}`
	r := httptest.NewRequest("POST", "/api/member-grants", strings.NewReader(body))
	r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
	ctx := cloud.WithVia(r.Context(), cloud.Via{LinkID: "lnk-00000001", HubUser: "hub-user-bbbb2222"})
	ctx = devicekey.WithRelayed(ctx, devicekey.Relayed{Kind: devicekey.GrantMember, Method: "POST", Path: "/api/member-grants", Link: "lnk-00000001", HubUser: "hub-user-bbbb2222", BodySHA256: devicekey.BodySHA256([]byte(body))})
	assert.False(t, memberOperatorOnly(httptest.NewRecorder(), r.WithContext(ctx)))
}
