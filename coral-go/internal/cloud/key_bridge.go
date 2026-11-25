package cloud

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubproxy"
	"github.com/subgentic/coral/pkg/tunnel"
)

// A self-hosted Hub's key link (#21220, design B) has no tunnel to its Hub: the Hub reaches this computer over HTTP with its request key. So that a key link means exactly what a tunnel link means, each
// one gets an in-process tunnel: the same LocalHandler a tunnel link runs (this link's cap read on every request, its LinkID stamped, View replies redacted, the Hub limits), dialed over an in-memory
// connection, and the key's requests are carried through it by the hub proxy the hosted path uses. A lowered cap ends the streams above it first (CloseAbove); a removed or revoked link's tunnel is closed,
// which ends every stream its key opened. Nothing here reads or keeps the key: the identity layer checked it before.

// keyBridgeOrigin is the Origin the bridge's proxy requires on a WebSocket upgrade. The caller is a request key sent alone (no cookie a browser could ride), so the proxy's browser check has nothing to
// guard here; the bridge sets this one value itself, after removing whatever the request brought.
const keyBridgeOrigin = "key-link.coral.internal"

type keyBridge struct {
	id      string
	cap     atomic.Int32 // tunnel.Mode
	cancel  context.CancelFunc
	local   *tunnel.LocalHandler
	session *tunnel.Session
	proxy   http.Handler
}

func (b *keyBridge) mode() tunnel.Mode { return tunnel.Mode(b.cap.Load()) }

// keyBridges are the running key links' tunnels, by link id.
type keyBridges struct {
	syncMu sync.Mutex // one sync at a time
	mu     sync.Mutex // m
	m      map[string]*keyBridge
}

// memListener is a net.Listener whose connections are in-memory pipes: the bridge's tunnel never touches a socket.
type memListener struct {
	conns  chan net.Conn
	closed chan struct{}
	once   sync.Once
}

func newMemListener() *memListener {
	return &memListener{conns: make(chan net.Conn), closed: make(chan struct{})}
}

func (l *memListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *memListener) Close() error { l.once.Do(func() { close(l.closed) }); return nil }

func (l *memListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)} }

func (l *memListener) dial(ctx context.Context, _, _ string) (net.Conn, error) {
	a, b := net.Pipe()
	select {
	case l.conns <- b:
		return a, nil
	case <-l.closed:
		return nil, net.ErrClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// startKeyBridge opens one key link's tunnel at cap cp. It returns once the tunnel is up, or an error.
func (m *Manager) startKeyBridge(root context.Context, l store.CloudLink, cp tunnel.Mode) (*keyBridge, error) {
	ctx, cancel := context.WithCancel(root)
	b := &keyBridge{id: l.LinkID, cancel: cancel}
	b.cap.Store(int32(cp))
	ln := newMemListener()
	sessions := make(chan *tunnel.Session, 1)
	srv := &http.Server{ReadHeaderTimeout: 10 * time.Second, ConnContext: auth.ConnContext /* an in-memory pipe: no address, so never the loopback pass */, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := tunnel.AcceptHTTP(w, r, func(context.Context, string) (any, error) { return l.LinkID, nil }, tunnel.SessionConfig{})
		if err != nil {
			return
		}
		select {
		case sessions <- s:
			<-ctx.Done() // the session lives as long as the bridge: AcceptHTTP's request context is the tunnel's
		default:
			s.Close()
		}
	})}
	go func() { defer safego.Recover("cloud/key_bridge:serve"); _ = srv.Serve(ln) }()
	go func() { defer safego.Recover("cloud/key_bridge:close"); <-ctx.Done(); _ = srv.Close(); _ = ln.Close() }()
	b.local = &tunnel.LocalHandler{
		BaseURL:         m.o.LocalBaseURL,
		AllowRequest:    tunnel.AllowRequest(b.mode), // this link's own cap, read on every request: the same table as a tunnel link's
		MaxMode:         b.mode,
		ViaValue:        ViaSecret(),
		LinkID:          l.LinkID,
		AllowOwnerStamp: true, // the Hub's owner stamp rides the tunnel to the local server, which checks it against this link's own hub secret (#21261)
		RedactTokens:    m.o.RedactTokens,
		Redactor:        m.o.Redactor,
		HubLimitsFunc:   m.o.HubLimits,
	}
	hc := &http.Client{Transport: &http.Transport{DialContext: ln.dial}}
	cs, err := tunnel.Dial(ctx, "ws://127.0.0.1/key-link", "key-link", tunnel.ClientOptions{Handler: b.local, LocalMode: b.mode, AllowInsecure: true, HTTPClient: hc, CoralVersion: m.o.CoralVersion})
	if err != nil {
		cancel()
		return nil, err
	}
	go func() { defer safego.Recover("cloud/key_bridge:close-client"); <-ctx.Done(); cs.Close() }()
	select {
	case b.session = <-sessions:
	case <-time.After(10 * time.Second):
		cancel()
		return nil, errors.New("cloud: the key link's tunnel did not open")
	}
	go func() { defer safego.Recover("cloud/key_bridge:close-session"); <-ctx.Done(); b.session.Close() }()
	target := hubproxy.TunnelTarget{Session: b.session}
	r := chi.NewRouter()
	r.Handle("/api/remote/{server}/*", hubproxy.NewWithOptions(oneTarget{id: l.LinkID, t: target}, hubproxy.Options{AllowedOrigins: []string{keyBridgeOrigin}, KeepOwnerStamp: true}))
	b.proxy = r
	return b, nil
}

type oneTarget struct {
	id string
	t  hubproxy.Target
}

func (o oneTarget) Resolve(_ context.Context, id string) (hubproxy.Target, error) {
	if id != o.id {
		return nil, hubproxy.ErrUnknownServer
	}
	return o.t, nil
}

// syncKeyBridges makes the running key-link tunnels match the active key links (called from LinksChanged): a new one is opened, a removed, revoked or paused one is closed (its streams end with it), and
// one whose cap changed is opened again at the new cap, a lowered cap first closing the streams above it. Closing happens under kb.mu; opening (up to 10 s each) does not, so one slow open never
// holds up the other key links' requests (QA's INFO on #21220). A link being opened answers ErrNoKeyLink meanwhile. syncMu keeps two syncs from opening the same link twice.
func (m *Manager) syncKeyBridges(root context.Context, links []store.CloudLink) {
	m.kb.syncMu.Lock()
	defer m.kb.syncMu.Unlock()
	want := map[string]store.CloudLink{}
	for _, l := range links {
		if l.Source == store.LinkSourceKey && l.State == store.LinkStateActive {
			want[l.LinkID] = l
		}
	}
	var open []store.CloudLink
	m.kb.mu.Lock()
	if m.kb.m == nil {
		m.kb.m = map[string]*keyBridge{}
	}
	for id, b := range m.kb.m {
		if _, ok := want[id]; !ok {
			b.cancel()
			delete(m.kb.m, id)
		}
	}
	for id, l := range want {
		cp := modeOf(l.MaxMode)
		if b := m.kb.m[id]; b != nil {
			if b.mode() == cp {
				continue
			}
			if cp < b.mode() {
				b.cap.Store(int32(cp))
				b.local.CloseAbove(cp)
			}
			b.cancel()
			delete(m.kb.m, id)
		}
		open = append(open, l)
	}
	m.kb.mu.Unlock()
	for _, l := range open {
		b, err := m.startKeyBridge(root, l, modeOf(l.MaxMode))
		if err != nil {
			m.o.Logger.Warn("cloud: could not open a key link's tunnel", "link", l.LinkID, "error", err.Error())
			continue
		}
		m.kb.mu.Lock()
		m.kb.m[l.LinkID] = b
		m.kb.mu.Unlock()
	}
}

// ErrNoKeyLink is a key whose link has no running tunnel here (none, or it is being opened again).
var ErrNoKeyLink = errors.New("cloud: that key's link is not open")

// ServeKeyLink carries one request of a linked request key through its link's tunnel. The identity layer has checked the key and found linkID; path is the request's own path. The key, every credential and
// the request's own Origin are removed before it is carried (the proxy's header allowlist forwards none of them either).
func (m *Manager) ServeKeyLink(w http.ResponseWriter, r *http.Request, linkID string) error {
	m.kb.mu.Lock()
	b := m.kb.m[linkID]
	m.kb.mu.Unlock()
	if b == nil {
		return ErrNoKeyLink
	}
	r2 := r.Clone(r.Context())
	for _, h := range []string{"X-Link-Request-Key", "Authorization", "Cookie", "X-API-Key", "Origin"} {
		r2.Header.Del(h)
	}
	if strings.EqualFold(r2.Header.Get("Upgrade"), "websocket") {
		r2.Header.Set("Origin", "http://"+keyBridgeOrigin)
	}
	r2.URL.Path = "/api/remote/" + linkID + r.URL.Path
	r2.URL.RawPath = ""
	if r.URL.RawPath != "" {
		r2.URL.RawPath = "/api/remote/" + linkID + r.URL.RawPath
	}
	r2.RequestURI = ""
	b.proxy.ServeHTTP(w, r2)
	return nil
}

// RunKeyLinks opens the key links' tunnels and keeps them until ctx ends. It runs whether or not this Coral has a hosted Hub (a computer a self-hosted Hub set up over SSH starts with --cloud-url off).
func (m *Manager) RunKeyLinks(ctx context.Context) {
	m.keyRoot.Store(&ctx)
	m.keyLinksChanged(ctx)
	<-ctx.Done()
	m.kb.mu.Lock()
	for id, b := range m.kb.m {
		b.cancel()
		delete(m.kb.m, id)
	}
	m.kb.mu.Unlock()
}

// keyLinksChanged makes the key links' tunnels match the store; nothing before RunKeyLinks started.
func (m *Manager) keyLinksChanged(ctx context.Context) {
	rp := m.keyRoot.Load()
	if rp == nil || m.o.Store == nil {
		return
	}
	links, err := m.o.Store.ListLinks(ctx)
	if err != nil {
		m.o.Logger.Warn("cloud: could not read the Hub links; the key links are unchanged")
		return
	}
	m.syncKeyBridges(*rp, links)
}
