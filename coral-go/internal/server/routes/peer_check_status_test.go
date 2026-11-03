package routes

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/peercred"
)

// #12546 (Security): the system status says when Coral cannot tell which account opens a sign-in link, as a plain flag, so Settings can say so in one line beside the version. False while the
// check works.
func TestSystemStatusSaysWhenThePeerCheckIsUnavailable(t *testing.T) {
	if !peercred.Supported {
		t.Skip("a system with no peer check never loses it")
	}
	h := newSystemHandlerForTest(t)
	t.Cleanup(auth.ResetPeerCheckLostForTest)
	auth.ResetPeerCheckLostForTest()
	flag := func() any {
		t.Helper()
		rec := httptest.NewRecorder()
		h.Status(rec, httptest.NewRequest(http.MethodGet, "/api/system/status", nil))
		require.Equal(t, http.StatusOK, rec.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out["peer_check_unavailable"]
	}
	assert.Equal(t, false, flag(), "the check works: nothing to say")

	t.Cleanup(auth.SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) { return peercred.Unsupported, nil }))
	r := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(auth.ConnContext(context.Background(), loopbackConn{}))
	r.RemoteAddr = "127.0.0.1:50000"
	_ = auth.PeerReason(r) // attributes the connection: the answer is Unsupported on a system that has a check, so the check is lost
	assert.Equal(t, true, flag())
}

type loopbackConn struct{ net.Conn }

func (loopbackConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 50000}
}
func (loopbackConn) LocalAddr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8420} }
func (loopbackConn) Close() error        { return nil }
