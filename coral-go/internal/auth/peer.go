package auth

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/peercred"
)

// The loopback pass is per user (#95, audit G4B). On Windows loopback isn't per user: another
// interactive, RDP or terminal-server user of this computer, or a process under WSL2's mirrored
// networking, reaches Coral from 127.0.0.1 too. So a loopback connection whose client socket the
// peer-user check (peercred) doesn't positively attribute to Coral's own OS user is treated as if
// require_auth_on_loopback were on for it: it always needs a credential (an agent's session token,
// the dashboard's sign-in, the API key; a command-line signature already needs the same user), even
// when strict local auth is off, and it never gets a local-only power (IsDirectLocal). Coral's own
// processes (the browser, the app, the tray, the command line, agents and hooks) are attributed to
// its user and keep everything they have.

// Peer reasons: why a loopback connection is not Coral's own user's. Short codes, for the 401's
// detail and the log; the account is never named.
const (
	PeerOtherUser    = "other_user"   // another OS user's process
	PeerUnattributed = "unattributed" // the owner couldn't be told (fail closed)
)

// connPeer is one TCP connection's attribution: worked out once, on the connection's first
// request, and kept for that connection only (never reused across connections, or by process id).
type connPeer struct {
	client, server netip.AddrPort
	known          bool // both addresses are TCP ones
	accepted       time.Time
	// mu guards the verdict. A definite one (Coral's user, or another user's) is kept for the connection; an unattributed one is NOT final: a later request on the same connection asks
	// again (at most every unattributedRetryEvery, and unattributedTries times), because the socket table can lag a connection by a moment (#385).
	mu      sync.Mutex
	decided bool
	reason  string
	tries   int
	lastTry time.Time
	verdict peercred.Verdict // what the attribution found, kept as the verdict and not as an "ok": the relay is a refusal that only the sign-in link tells apart (#396)
}

const (
	unattributedRetryEvery = 100 * time.Millisecond
	unattributedTries      = 5
)

type connPeerKey struct{}

// attributePeer is peercred.AttributeAt (a test seam: SetPeerAttribution).
var attributePeer = peercred.AttributeAt

// SetPeerAttribution replaces how a loopback connection is attributed and returns the function
// that puts it back: for tests in other packages, which can't make another OS user's connection.
func SetPeerAttribution(f func(client, server netip.AddrPort) (peercred.Verdict, error)) (restore func()) {
	old := attributePeer
	attributePeer = func(client, server netip.AddrPort, _ time.Time) (peercred.Verdict, error) { return f(client, server) }
	return func() { attributePeer = old }
}

// ConnContext is the main server's http.Server.ConnContext: it gives each connection its
// attribution, worked out on its first loopback request (in that connection's goroutine, so a
// socket table read never holds up the accept loop) and kept for the connection. Every connection
// gets one, so a server with ConnContext never falls back to the rules from before #95: a
// connection whose addresses aren't TCP ones it can read is unattributed (fail closed) for a
// loopback request.
func ConnContext(ctx context.Context, c net.Conn) context.Context {
	client, ok1 := tcpAddrPort(c.RemoteAddr())
	server, ok2 := tcpAddrPort(c.LocalAddr())
	now := time.Now()
	ctx = peercred.WithAccepted(ctx, now)
	return context.WithValue(ctx, connPeerKey{}, &connPeer{client: client, server: server, known: ok1 && ok2, accepted: now})
}

// remoteIsLoopback reports whether r's peer address (the connection's, as net/http sets it) is a
// loopback one.
func remoteIsLoopback(r *http.Request) bool {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	return err == nil && ap.Addr().Unmap().IsLoopback()
}

func tcpAddrPort(a net.Addr) (netip.AddrPort, bool) {
	t, ok := a.(*net.TCPAddr)
	if !ok || t == nil {
		return netip.AddrPort{}, false
	}
	return t.AddrPort(), true
}

// PeerReason is why r's loopback connection is not Coral's own user's (PeerOtherUser or
// PeerUnattributed), or "" when it is, when the system can't tell users apart (the rules from
// before #95), when the connection isn't a loopback one, or when the server attributes no
// connections (ConnContext not installed: tests and embedders; every production server installs
// it, which startup's tests check).
func PeerReason(r *http.Request) string {
	cp, _ := r.Context().Value(connPeerKey{}).(*connPeer)
	if cp == nil {
		return ""
	}
	if cp.known && !cp.client.Addr().Unmap().IsLoopback() {
		return "" // not a loopback connection: the loopback pass doesn't apply to it
	}
	if !cp.known && !remoteIsLoopback(r) {
		return ""
	}
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if cp.decided {
		return cp.reason
	}
	if !cp.known {
		cp.decided, cp.reason = true, PeerUnattributed
		logPeer(cp.client.Addr(), cp.reason, errors.New("the connection's addresses are not TCP ones Coral can read"))
		return cp.reason
	}
	if cp.reason == PeerUnattributed && (cp.tries >= unattributedTries || time.Since(cp.lastTry) < unattributedRetryEvery) {
		return cp.reason // asked a moment ago (or often enough): still unattributed, fail closed
	}
	cp.tries++
	cp.lastTry = time.Now()
	attributeSlots <- struct{}{} // at most a few socket-table reads at once (#95 review F5)
	v, err := attributePeer(cp.client, cp.server, cp.accepted)
	cp.verdict = v
	<-attributeSlots
	if v == peercred.Unsupported && peercred.Supported {
		peerCheckLost.Store(true) // this OS version's socket table isn't one this build reads (F3)
	}
	switch v {
	case peercred.OtherUser:
		cp.decided, cp.reason = true, PeerOtherUser
	case peercred.Relay:
		cp.decided, cp.reason = true, PeerOtherUser // for everything but the sign-in link, the relay is another user (#396)
		logRelay(cp.client.Addr())
		return cp.reason
	case peercred.Unattributed:
		cp.reason = PeerUnattributed // not final: the next request asks again
	default:
		cp.decided, cp.reason = true, "" // Coral's own user (or no check on this system)
		return cp.reason
	}
	logPeer(cp.client.Addr(), cp.reason, err)
	return cp.reason
}

// PeerIsRelay reports whether r's loopback connection is WSL's localhost relay (peercred.Relay, #396): a root-owned loopback socket on a WSL kernel, behind which the Windows user cannot be
// told. The ONLY thing that may act on it is the sign-in link (handleLoginToken); every other check (PeerReason, SameUser) treats it as another user. False without ConnContext, for a
// connection that is not loopback, and for any other verdict.
func PeerIsRelay(r *http.Request) bool {
	if !remoteIsLoopback(r) || PeerReason(r) == "" { // a request from another computer is never the relay; PeerReason attributes the connection once
		return false
	}
	cp, _ := r.Context().Value(connPeerKey{}).(*connPeer)
	if cp == nil {
		return false
	}
	cp.mu.Lock() // the verdict is written under this lock by PeerReason
	defer cp.mu.Unlock()
	return cp.verdict == peercred.Relay
}

var relayLog struct {
	sync.Mutex
	last time.Time
}

// logRelay says, once a minute, that a loopback connection came through WSL's relay.
func logRelay(addr netip.Addr) {
	relayLog.Lock()
	defer relayLog.Unlock()
	if time.Since(relayLog.last) < time.Minute {
		return
	}
	relayLog.last = time.Now()
	log.Printf("[auth] a loopback connection from %s comes through WSL's localhost relay (a root-owned socket on the VM's loopback): which Windows user is behind it can't be told, so it needs a credential like another user's and gets no local-only power; a sign-in link may still be opened through it", addr)
}

// attributeSlots caps the socket-table reads running at once (#95 review F5): each new loopback
// connection costs one, so a local program opening connections in a burst can't make Coral read the
// table on every core at once. The others wait their turn.
var attributeSlots = make(chan struct{}, 4)

// peerCheckLost is set when the peer-user check answered Unsupported on a system that has one: its
// socket table has a layout this build doesn't know, so the loopback pass is per machine again.
var peerCheckLost atomic.Bool

// ResetPeerCheckLostForTest clears the lost-check flag. The flag is sticky in a running server (a layout this build can't read stays
// unreadable), and it takes the local-only powers from every request, so a test that makes the attribution answer Unsupported must put
// the flag back, or the tests that run after it in the same process lose those powers.
func ResetPeerCheckLostForTest() { peerCheckLost.Store(false) }

// PeerCheckWarning is the dashboard's line when the loopback pass can't be per user on this
// computer although the system could tell users apart (#95 review F3), or "".
func PeerCheckWarning() string {
	if !peerCheckLost.Load() {
		return ""
	}
	return "Coral can't tell which account a connection from this computer comes from (this OS version's socket table isn't one this build reads), so every account on this computer gets the no-sign-in pass that is meant only for Coral's own, and nobody gets the local-only powers (reading the API key, the file explorer's relaxed bounds, Coral Hub settings, opening an editor) until Coral is updated. Keep strict local auth on, and update Coral."
}

// peerLog limits the line for a connection that is not Coral's own user's to one a minute per
// client address and reason, so a mis-attribution on a real machine can be found in the log
// without a line per request.
var peerLog = struct {
	sync.Mutex
	last map[string]time.Time
}{last: map[string]time.Time{}}

func logPeer(addr netip.Addr, reason string, err error) {
	key := addr.String() + " " + reason
	peerLog.Lock()
	if time.Since(peerLog.last[key]) < time.Minute {
		peerLog.Unlock()
		return
	}
	if len(peerLog.last) > 1024 {
		peerLog.last = map[string]time.Time{}
	}
	peerLog.last[key] = time.Now()
	peerLog.Unlock()
	why := "another user's process"
	if reason == PeerUnattributed {
		why = "a process whose user couldn't be told"
		if err != nil {
			why += " (" + err.Error() + ")"
		}
	}
	log.Printf("[auth] a loopback connection from %s is %s (%s): it needs a credential like a request from another computer, and gets no local-only power", addr, why, reason)
}
