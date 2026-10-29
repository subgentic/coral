package auth

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/peercred"
)

// #95 review F1: a server with ConnContext never falls back to the rules from before #95. A
// connection whose addresses aren't TCP ones (here a pipe) is unattributed for a loopback request,
// without asking the system; a request from another computer has no reason; a TCP loopback
// connection is asked once.
func TestConnContextFailsClosedOnAddressesItCannotRead(t *testing.T) {
	asked := 0
	t.Cleanup(SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) {
		asked++
		return peercred.Self, nil
	}))
	c1, c2 := net.Pipe()
	t.Cleanup(func() { c1.Close(); c2.Close() })

	pipeCtx := ConnContext(context.Background(), c1)
	r := httptest.NewRequest("GET", "/api/x", nil).WithContext(pipeCtx)
	r.RemoteAddr = "127.0.0.1:50000"
	assert.Equal(t, PeerUnattributed, PeerReason(r), "unreadable addresses: fail closed")
	assert.False(t, isDirectLocal(r))

	// A wrapped connection whose address is not a *net.TCPAddr but prints as a loopback one (as
	// net/http's RemoteAddr would show it).
	wrapped := stringAddrConn{Conn: c1, addr: stringAddr("127.0.0.1:50001")}
	r = httptest.NewRequest("GET", "/api/x", nil).WithContext(ConnContext(context.Background(), wrapped))
	r.RemoteAddr = wrapped.RemoteAddr().String()
	assert.Equal(t, PeerUnattributed, PeerReason(r), "a non-TCP address with a loopback string: fail closed")
	assert.False(t, isDirectLocal(r))

	r = httptest.NewRequest("GET", "/api/x", nil).WithContext(ConnContext(context.Background(), c1))
	r.RemoteAddr = "192.0.2.7:50000"
	assert.Equal(t, "", PeerReason(r), "not a loopback request: no reason")
	assert.Zero(t, asked, "the system is never asked for a connection it can't name")

	tcpCtx := ConnContext(context.Background(), tcpConn{})
	r = httptest.NewRequest("GET", "/api/x", nil).WithContext(tcpCtx)
	r.RemoteAddr = "127.0.0.1:50000"
	assert.Equal(t, "", PeerReason(r))
	assert.Equal(t, "", PeerReason(r))
	assert.Equal(t, 1, asked, "asked once per connection")
}

// #385: only a positive identity is kept for a connection. An unattributed answer is not final: a later request on the same connection asks again (not more often than
// unattributedRetryEvery, and unattributedTries times at most), fails closed meanwhile, and a Self answer is then kept; it is never inherited by another connection.
func TestAnUnattributedConnectionIsAskedAgainAndOnlyAPositiveIdentityIsKept(t *testing.T) {
	answers := []peercred.Verdict{peercred.Unattributed, peercred.Unattributed, peercred.Self}
	asked := 0
	t.Cleanup(SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) {
		v := answers[min(asked, len(answers)-1)]
		asked++
		return v, nil
	}))
	req := func(cp context.Context) *http.Request {
		r := httptest.NewRequest("GET", "/api/x", nil).WithContext(cp)
		r.RemoteAddr = "127.0.0.1:50000"
		return r
	}
	ctx := ConnContext(context.Background(), tcpConn{})
	assert.Equal(t, PeerUnattributed, PeerReason(req(ctx)), "unattributed: fail closed")
	assert.Equal(t, PeerUnattributed, PeerReason(req(ctx)), "asked a moment ago: still closed, and not asked again")
	assert.Equal(t, 1, asked)
	time.Sleep(unattributedRetryEvery + 20*time.Millisecond)
	assert.Equal(t, PeerUnattributed, PeerReason(req(ctx)), "asked again: still unattributed")
	assert.Equal(t, 2, asked)
	time.Sleep(unattributedRetryEvery + 20*time.Millisecond)
	assert.Equal(t, "", PeerReason(req(ctx)), "the table caught up: Coral's own user")
	assert.Equal(t, 3, asked)
	assert.Equal(t, "", PeerReason(req(ctx)))
	assert.Equal(t, 3, asked, "a positive identity is kept for the connection")

	other := ConnContext(context.Background(), tcpConn{})
	asked = 0
	answers = []peercred.Verdict{peercred.Unattributed}
	assert.Equal(t, PeerUnattributed, PeerReason(req(other)), "another connection does not inherit the allowed one")
}

// A positively-other-user answer is final too, and is never asked again; an unattributed connection stops being asked after unattributedTries.
func TestAPositiveOtherUserIsFinalAndTheRetriesAreBounded(t *testing.T) {
	verdict := peercred.OtherUser
	asked := 0
	t.Cleanup(SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) { asked++; return verdict, nil }))
	req := func(cp context.Context) *http.Request {
		r := httptest.NewRequest("GET", "/api/x", nil).WithContext(cp)
		r.RemoteAddr = "127.0.0.1:50000"
		return r
	}
	ctx := ConnContext(context.Background(), tcpConn{})
	assert.Equal(t, PeerOtherUser, PeerReason(req(ctx)))
	assert.Equal(t, PeerOtherUser, PeerReason(req(ctx)))
	assert.Equal(t, 1, asked, "final")

	verdict, asked = peercred.Unattributed, 0
	ctx = ConnContext(context.Background(), tcpConn{})
	for i := 0; i < unattributedTries+3; i++ {
		assert.Equal(t, PeerUnattributed, PeerReason(req(ctx)))
		time.Sleep(unattributedRetryEvery + 10*time.Millisecond)
	}
	assert.Equal(t, unattributedTries, asked, "asked a bounded number of times, then fail closed")
}

type stringAddr string

func (a stringAddr) Network() string { return "wrapped" }
func (a stringAddr) String() string  { return string(a) }

type stringAddrConn struct {
	net.Conn
	addr net.Addr
}

func (c stringAddrConn) RemoteAddr() net.Addr { return c.addr }

// #95 review F3: when the system has a peer check but its socket table isn't one this build reads
// (Unsupported), the dashboard's security warning says the loopback pass is per machine again.
func TestPeerCheckWarningWhenTheCheckIsLost(t *testing.T) {
	t.Cleanup(func() { peerCheckLost.Store(false) })
	peerCheckLost.Store(false)
	assert.Empty(t, PeerCheckWarning())
	t.Cleanup(SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) {
		return peercred.Unsupported, nil
	}))
	r := httptest.NewRequest("GET", "/", nil).WithContext(ConnContext(context.Background(), tcpConn{}))
	r.RemoteAddr = "127.0.0.1:50000"
	assert.Equal(t, "", PeerReason(r), "unsupported keeps the rules from before #95")
	if peercred.Supported {
		assert.Contains(t, PeerCheckWarning(), "every account on this computer")
	} else {
		assert.Empty(t, PeerCheckWarning(), "a system without a peer check never had a per-user pass")
	}
}

// The lost peer check (#5738 ruling): on a system that has one but whose socket table this build can't read, no request gets a local-only power
// (IsDirectLocal, the API key routes), while the credential-free pass keeps the rule from before #95.
func TestLostPeerCheckGivesNoLocalOnlyPower(t *testing.T) {
	if !peercred.Supported {
		t.Skip("a system without a peer check never had a per-user pass")
	}
	t.Cleanup(func() { peerCheckLost.Store(false) })
	peerCheckLost.Store(false)
	request := func() *http.Request {
		r := httptest.NewRequest("GET", "/api/auth/key", nil).WithContext(ConnContext(context.Background(), tcpConn{}))
		r.RemoteAddr = "127.0.0.1:50000"
		return r
	}
	keyRoute := func(r *http.Request) (int, string) {
		w := httptest.NewRecorder()
		(&Routes{}).keyRoutesRefuse(w, r)
		return w.Code, w.Body.String()
	}

	restore := SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) { return peercred.Self, nil })
	r := request()
	assert.True(t, IsDirectLocal(r), "Coral's own account, check working: the power")
	code, body := keyRoute(request())
	assert.Equal(t, http.StatusUnauthorized, code, "past the locality check, on to the Operator check: %s", body)
	restore()

	t.Cleanup(SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) { return peercred.Unsupported, nil }))
	r = request()
	assert.False(t, IsDirectLocal(r), "the check is lost: no local-only power for anyone")
	assert.True(t, localOperator(r), "the credential-free pass keeps the old rule")
	assert.True(t, IsDirectLocalPeer(r))
	code, body = keyRoute(request())
	assert.Equal(t, http.StatusForbidden, code, "the API key routes refuse too: %s", body)
	assert.Contains(t, body, "localhost only")
	assert.NotEmpty(t, PeerCheckWarning())
}

// #95 review F5: at most cap(attributeSlots) socket-table reads run at once.
func TestAttributionsAreCapped(t *testing.T) {
	var mu sync.Mutex
	running, most := 0, 0
	release := make(chan struct{})
	t.Cleanup(SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) {
		mu.Lock()
		running++
		if running > most {
			most = running
		}
		mu.Unlock()
		<-release
		mu.Lock()
		running--
		mu.Unlock()
		return peercred.Self, nil
	}))
	var wg sync.WaitGroup
	for i := 0; i < 3*cap(attributeSlots); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/", nil).WithContext(ConnContext(context.Background(), tcpConn{}))
			r.RemoteAddr = "127.0.0.1:50000"
			PeerReason(r)
		}()
	}
	require.Eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return running == cap(attributeSlots) }, 5*time.Second, 5*time.Millisecond)
	time.Sleep(50 * time.Millisecond) // give any extra one the chance to start
	close(release)
	wg.Wait()
	assert.Equal(t, cap(attributeSlots), most, "never more than the cap at once")
}

type tcpConn struct{ net.Conn }

func (tcpConn) RemoteAddr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 50000} }
func (tcpConn) LocalAddr() net.Addr  { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8420} }
