package cloud

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// One connector per active link (#20368, multi-Hub design v2). The link the one enrollment mirrors is still run by the Manager's own tunnel (its cap is the setting, its sign-in, relay and device pairing are the
// Manager's); every other active link, one added at this computer, has a linkConn of its own: its own token, its own tunnel to its own Hub, its own cap, its own state. They share nothing that could carry one
// link's state to another: ending, refusing or lowering one never touches the rest.

// LinkStatus is the safe, secret-free state of one link's tunnel.
type LinkStatus struct {
	State       string    `json:"state"`
	LastError   string    `json:"last_error,omitempty"`
	ConnectedAt time.Time `json:"connected_at,omitzero"`
}

// linkConn is one added link's connector. A restart makes a new one, so a stopped connector's late writes land on an object nobody reads.
type linkConn struct {
	id      string
	cancel  context.CancelFunc
	cap     atomic.Int32 // tunnel.Mode of this link's own cap
	local   atomic.Pointer[tunnel.LocalHandler]
	session atomic.Pointer[tunnel.ClientSession]
	mu      sync.Mutex
	st      LinkStatus
}

func (lc *linkConn) mode() tunnel.Mode { return tunnel.Mode(lc.cap.Load()) }

func (lc *linkConn) set(state, msg string) {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	if state == StateConnected && lc.st.State != StateConnected {
		lc.st.ConnectedAt = time.Now().UTC()
	} else if state != StateConnected {
		lc.st.ConnectedAt = time.Time{}
	}
	lc.st.State, lc.st.LastError = state, msg
}

func (lc *linkConn) status() LinkStatus {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	return lc.st
}

func modeOf(name string) tunnel.Mode {
	switch name {
	case "launch":
		return tunnel.TierLaunch
	case "interact":
		return tunnel.TierInteract
	}
	return tunnel.TierView
}

// LinksChanged makes the running connectors match the store: an active link added here gets a connector, one that is removing, revoked or gone loses its, and one whose cap changed is dialed again at the new cap
// (a lowered cap first ends the streams the old one allowed, so nothing outlives it). It is called at start, after a link is added or removed and after a cap changes; it is safe to call at any time.
func (m *Manager) LinksChanged(ctx context.Context) {
	m.mu.Lock()
	root := m.root
	m.mu.Unlock()
	if m.o.HubURL == "" || root == nil || m.o.Store == nil {
		return
	}
	links, err := m.o.Store.ListLinks(ctx)
	if err != nil {
		m.o.Logger.Warn("cloud: could not read the Hub links; the connectors are unchanged")
		return
	}
	want := map[string]store.CloudLink{}
	for _, l := range links {
		if l.Source == store.LinkSourceAdded && l.State == store.LinkStateActive {
			want[l.LinkID] = l
		}
	}
	m.lmu.Lock()
	defer m.lmu.Unlock()
	if m.extras == nil {
		m.extras = map[string]*linkConn{}
	}
	for id, lc := range m.extras {
		if _, ok := want[id]; !ok {
			lc.cancel()
			delete(m.extras, id)
		}
	}
	for id, l := range want {
		cp := modeOf(l.MaxMode)
		lc := m.extras[id]
		switch {
		case lc == nil:
		case lc.mode() == cp:
			continue
		default:
			if cp < lc.mode() {
				if lh := lc.local.Load(); lh != nil {
					lh.CloseAbove(cp)
				}
			}
			lc.cancel()
		}
		m.extras[id] = m.startLink(root, l, cp)
	}
}

// StopLink ends one link's tunnel and nothing else: the connector of a link added here, or the Manager's own tunnel when the link is the enrollment's. A link being removed has no tunnel from the moment the person asks.
func (m *Manager) StopLink(linkID string) {
	m.lmu.Lock()
	lc := m.extras[linkID]
	if lc != nil {
		lc.cancel()
		delete(m.extras, linkID)
	}
	m.lmu.Unlock()
	if lc != nil {
		return
	}
	if m.o.Store != nil && m.o.HubURL != "" {
		if l, err := m.o.Store.LinkByOrigin(context.Background(), m.o.HubURL); err == nil && l.LinkID == linkID {
			m.StopTunnel()
		}
	}
}

// LinkStatus is one link's tunnel state: its own connector's, the Manager's for the enrollment's link, and idle (or revoked, when the store says so) for a link with no connector.
func (m *Manager) LinkStatus(linkID string) LinkStatus {
	m.lmu.Lock()
	lc := m.extras[linkID]
	m.lmu.Unlock()
	if lc != nil {
		return lc.status()
	}
	if m.o.Store != nil {
		if links, err := m.o.Store.ListLinks(context.Background()); err == nil {
			for _, l := range links {
				if l.LinkID != linkID {
					continue
				}
				switch {
				case l.Source == store.LinkSourceEnrollment:
					s := m.Status()
					return LinkStatus{State: s.State, LastError: s.LastError, ConnectedAt: s.ConnectedAt}
				case l.State == store.LinkStateRevoked:
					return LinkStatus{State: StateRevoked, LastError: derefStr(l.LastError)}
				}
			}
		}
	}
	return LinkStatus{State: StateIdle}
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (m *Manager) startLink(root context.Context, l store.CloudLink, cp tunnel.Mode) *linkConn {
	ctx, cancel := context.WithCancel(root)
	lc := &linkConn{id: l.LinkID, cancel: cancel, st: LinkStatus{State: StateConnecting}}
	lc.cap.Store(int32(cp))
	go func() { defer safego.Recover("cloud/manager:m.runLink"); m.runLink(ctx, lc, l.HubOrigin) }()
	return lc
}

// runLink dials one added link's Hub with that link's own token until it is stopped or the Hub refuses the token. The stamp on every request is the link's id, from the store row that opened this tunnel.
func (m *Manager) runLink(ctx context.Context, lc *linkConn, origin string) {
	token, err := m.o.Store.LinkToken(ctx, lc.id)
	if err != nil {
		lc.set(StateKeyUnreadable, "the stored token cannot be decrypted (master key missing or changed); remove this link and add it again")
		return
	}
	local := &tunnel.LocalHandler{
		BaseURL:       m.o.LocalBaseURL,
		AllowRequest:  tunnel.AllowRequest(lc.mode), // this link's own cap, read on every request
		MaxMode:       lc.mode,
		ViaValue:      ViaSecret(),
		LinkID:        lc.id,
		RedactTokens:  m.o.RedactTokens,
		Redactor:      m.o.Redactor,
		HubLimitsFunc: m.o.HubLimits,
	}
	lc.local.Store(local)
	err = tunnel.Run(ctx, TunnelURL(origin), token, tunnel.ClientOptions{
		Handler:       local,
		CoralVersion:  m.o.CoralVersion,
		LocalMode:     lc.mode,
		AllowInsecure: config.AllowInsecureCloud,
		HTTPClient:    m.hc,
		Backoff:       m.o.Backoff,
		Logger:        m.o.Logger,
		OnSession:     func(cs *tunnel.ClientSession) { lc.session.Store(cs) },
		RouteKey: func() string {
			k, _ := m.o.Store.RouteKey(ctx, origin)
			return k
		},
		OnRouteKey: func(k string) {
			if old, _ := m.o.Store.RouteKey(ctx, origin); old != k {
				_ = m.o.Store.SetRouteKey(ctx, origin, k)
			}
		},
		OnState: func(connected bool, err error) {
			if ctx.Err() != nil {
				return
			}
			switch {
			case connected:
				lc.set(StateConnected, "")
			case errors.Is(err, tunnel.ErrUnauthorized), errors.Is(err, tunnel.ErrUnsupportedVersion):
				// Run returns right after this; handled below.
			case errors.Is(err, tunnel.ErrRetryLater):
				lc.set(StateRetrying, "the hub is busy; retrying")
			default:
				lc.set(StateRetrying, "the hub is unreachable; retrying")
			}
		},
	})
	switch {
	case ctx.Err() != nil:
		return
	case errors.Is(err, tunnel.ErrUnauthorized):
		// The Hub does not accept this link's token: this link is revoked and stops; every other link is untouched.
		_ = m.o.Store.MarkLinkRevoked(context.Background(), lc.id, "revoked by the hub")
		lc.set(StateRevoked, "the hub revoked this link; remove it and add it again to reconnect")
	case errors.Is(err, tunnel.ErrUnsupportedVersion):
		lc.set(StateUpgrade, "this Coral version is too old for the hub; update Coral")
	}
}
