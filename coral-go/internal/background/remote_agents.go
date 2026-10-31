package background

// RemoteAgentHub keeps an in-memory view of the agents running on registered
// remote Coral servers, for the multi-server hub (see the team's internal notes,
// section 3 of the hub spec).
//
// FRONTEND CONTRACT (what the hub's list and feed expose):
//   - every session object carries "server" (string): "local" for hub agents,
//     the server id for remote agents. Remote agents may also carry
//     "stale": true when their server is not online (last-known data).
//   - GET /api/sessions/live returns a plain JSON array when no remotes are
//     registered (unchanged from before). When at least one remote is
//     registered it returns {"sessions":[...], "servers":[{id,label,status}]}.
//   - /ws/coral coral_update / coral_diff messages follow the same rules: when
//     remotes exist they carry "servers" and every session has "server".
//     coral_diff removals of remote sessions are reported in "removed_remote":
//     [{"server":id,"key":session_id-or-name}]; "removed" only lists local keys.
//
// Each registered remote that is not key_unreadable gets its own goroutine that
// polls GET /api/sessions/live every ~5s (jittered, per-request timeout, backoff
// 1s..30s on failure) and a second goroutine holding an upstream /ws/coral feed
// socket. While the feed is connected its data supersedes the poll for the
// session list, so the poll only checks liveness with GET /api/health (the list
// is ~1 KB per agent and costs the remote a full build; health is ~40 bytes and
// static). The full list is fetched again when the feed drops, or when it has
// been quiet for FeedQuietRefresh (a remote whose handlers hang keeps a silent
// socket). The feed socket is pinged every FeedPingInterval (a keepalive, 30s)
// and dropped when two pings in a row go unanswered. A server shown online is
// shown unreachable only after its probes have failed for OfflineGrace, so a
// brief reconnect never flashes "offline" (#3649). When the feed cannot be
// established the poll data is used.

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// RemoteRegistry is the part of store.RemoteServerStore the hub needs.
type RemoteRegistry interface {
	List(ctx context.Context) ([]store.RemoteServer, error)
	SetStatus(ctx context.Context, id, status, errMsg string) error
}

// RemoteServerStatus is the per-server summary returned in "servers".
type RemoteServerStatus struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"`
	// Shown in the sidebar hover card.
	URL       string `json:"url,omitempty"`
	LastSeen  string `json:"last_seen,omitempty"`
	LastError string `json:"last_error,omitempty"`
	Agents    int    `json:"agents"`
	Version   string `json:"version,omitempty"`
	// OwnerStamp: this hub can have Approve, Request changes and the change-request send of this computer signed for it (#11378): the hub holds the secret AND the computer says it holds the other half.
	OwnerStamp bool `json:"owner_stamp"`
}

// RemoteAgentSource is consumed by the session routes.
type RemoteAgentSource interface {
	Snapshot() RemoteSnapshot
	// Subscribe returns a channel that receives a signal (coalesced) whenever
	// remote data or status changes, and a cancel func.
	Subscribe() (<-chan struct{}, func())
}

// RemoteAgentHubConfig tunes timings; zero values use production defaults.
type RemoteAgentHubConfig struct {
	PollInterval    time.Duration // default 5s
	RequestTimeout  time.Duration // default 10s
	RegistryRefresh time.Duration // default 10s
	MinBackoff      time.Duration // default 1s
	MaxBackoff      time.Duration // default 30s
	// FeedQuietRefresh: while the feed is live the list is not polled, unless
	// no feed message arrived for this long. Default 30s.
	FeedQuietRefresh time.Duration
	// FeedPingInterval: how often the upstream feed socket is pinged; it is
	// dropped after two pings in a row go unanswered. Default 30s: a keepalive,
	// not the liveness check (the polls and the status grace are). The agent
	// list and status probes keep PollInterval (#3649).
	FeedPingInterval time.Duration
	// OfflineGrace: a server shown online is shown unreachable only after its
	// probes have failed for this long, so a connection that drops and comes
	// back (an SSH port forward, a slow link) never flashes "offline" (#3649).
	// A rejected key, a refused host or an unreadable key shows at once.
	// Default 20s; negative means none (every failure shows at once).
	OfflineGrace time.Duration
}

func (c *RemoteAgentHubConfig) fill() {
	if c.PollInterval <= 0 {
		c.PollInterval = 5 * time.Second
	}
	if c.RequestTimeout <= 0 {
		c.RequestTimeout = 10 * time.Second
	}
	if c.RegistryRefresh <= 0 {
		c.RegistryRefresh = 10 * time.Second
	}
	if c.MinBackoff <= 0 {
		c.MinBackoff = time.Second
	}
	if c.MaxBackoff <= 0 {
		c.MaxBackoff = 30 * time.Second
	}
	if c.FeedQuietRefresh <= 0 {
		c.FeedQuietRefresh = 30 * time.Second
	}
	if c.FeedPingInterval <= 0 {
		c.FeedPingInterval = 30 * time.Second
	}
	if c.OfflineGrace == 0 {
		c.OfflineGrace = 20 * time.Second
	}
}

type remoteState struct {
	srv        store.RemoteServer
	cancel     context.CancelFunc
	status     string
	sessions   []map[string]any
	feedLive   bool
	feedMsgAt  time.Time // last message of any type received on the feed
	noHealth   bool      // remote predates /api/health (404): liveness uses the list
	lastDB     time.Time // last SetStatus write (online or failure)
	lastErr    string    // error message of the last failure write
	lastSig    string
	version    string // remote's reported version (best effort)
	ownerStamp bool   // the remote says it holds the secret that verifies this hub's owner stamps (#11378)
	// failingSince is when the current run of unreachable probes began while the
	// server was shown online (zero when none): within OfflineGrace it stays
	// online (#3649).
	failingSince time.Time
	versionAt    time.Time // when it was last fetched
	// wake asks the poll loop to probe now instead of after its wait, e.g.
	// after a proxied request to this remote failed (#3202).
	wake chan struct{}
}

func newRemoteState() *remoteState { return &remoteState{wake: make(chan struct{}, 1)} }

// kick wakes the poll loop (coalesced). Call with h.mu held.
func (st *remoteState) kick() {
	select {
	case st.wake <- struct{}{}:
	default:
	}
}

// rowNeedsWrite reports whether the registry row must be rewritten now: the
// status changed, the row says something else (another writer, such as Test or
// the proxy, put a different status there), or the periodic last_seen write is
// due. Call with h.mu held.
func (st *remoteState) rowNeedsWrite(changed bool, status string) bool {
	return changed || st.srv.Status != status || time.Since(st.lastDB) >= remoteSeenWriteEvery
}

// remoteSeenWriteEvery bounds the remote_servers writes for a remote whose
// status is unchanged: last_seen (and a repeated error) is refreshed at most
// this often, so the UI's "last contact" is accurate to about a minute. A
// status change is always written at once (#3142).
var remoteSeenWriteEvery = time.Minute

// RemoteAgentHub implements RemoteAgentSource.
type RemoteAgentHub struct {
	reg      RemoteRegistry
	resolver proxy.Resolver
	cfg      RemoteAgentHubConfig
	logger   *slog.Logger
	// now and sleep are the clock the probe spacing reads; tests replace them to drive a burst without real time (#4958).
	now   func() time.Time
	sleep func(ctx context.Context, d time.Duration) bool

	mu      sync.Mutex
	remotes map[string]*remoteState
	subs    map[int]chan struct{}
	nextSub int
	gen     atomic.Uint64   // bumped on every notify, before subscribers are signalled
	snap    *RemoteSnapshot // built on demand, cleared on every change
}

// Generation increases whenever subscribers are notified of a change, so a
// reader can tell whether a snapshot it holds predates the latest change.
func (h *RemoteAgentHub) Generation() uint64 { return h.gen.Load() }

// NewRemoteAgentHub creates the hub. Call Run to start it.
func NewRemoteAgentHub(reg RemoteRegistry, resolver proxy.Resolver, cfg RemoteAgentHubConfig) *RemoteAgentHub {
	cfg.fill()
	return &RemoteAgentHub{
		reg: reg, resolver: resolver, cfg: cfg,
		logger:  slog.Default().With("service", "remote_agents"),
		now:     time.Now,
		sleep:   SleepCtx,
		remotes: map[string]*remoteState{},
		subs:    map[int]chan struct{}{},
	}
}

// Run reconciles the registry until ctx ends.
func (h *RemoteAgentHub) Run(ctx context.Context) {
	h.reconcile(ctx)
	t := time.NewTicker(h.cfg.RegistryRefresh)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			for _, st := range h.remotes {
				if st.cancel != nil {
					st.cancel()
				}
			}
			h.mu.Unlock()
			proxy.CloseIdleConnections() // no keep-alive connections left behind
			return
		case <-t.C:
			h.reconcile(ctx)
		}
	}
}

// reconcile starts, restarts and stops per-remote workers to match the registry.
func (h *RemoteAgentHub) reconcile(ctx context.Context) {
	list, err := h.reg.List(ctx)
	if err != nil {
		if ctx.Err() == nil {
			h.logger.Warn("remote registry read failed", "error", err)
		}
		return
	}
	// A row marked key_unreadable stops its worker only if the key really cannot
	// be read now. Another writer (the proxy) may have put that status there, and
	// a stopped worker would otherwise stay stopped until Test (#3202). Checked
	// outside the lock: it reads and decrypts the key.
	keyUnreadable := map[string]bool{}
	for _, rs := range list {
		if rs.Status == store.RemoteStatusKeyUnreadable {
			_, rerr := h.resolver.Resolve(ctx, rs.ID)
			keyUnreadable[rs.ID] = errors.Is(rerr, proxy.ErrKeyUnreadable)
		}
	}
	changed := false
	h.mu.Lock()
	seen := map[string]bool{}
	for _, rs := range list {
		seen[rs.ID] = true
		st := h.remotes[rs.ID]
		if st != nil && (st.srv.URL != rs.URL || st.srv.AllowPrivate != rs.AllowPrivate) && st.cancel != nil {
			st.cancel()
			st.cancel = nil
			st.sessions, st.feedLive, st.status, st.noHealth = nil, false, "", false
		}
		if st == nil {
			st = newRemoteState()
			h.remotes[rs.ID] = st
			changed = true
		}
		st.srv = rs
		if rs.Status == store.RemoteStatusKeyUnreadable && keyUnreadable[rs.ID] {
			if st.cancel != nil {
				st.cancel()
				st.cancel = nil
			}
			if st.status != store.RemoteStatusKeyUnreadable {
				h.logTransition(rs.ID, st.status, store.RemoteStatusKeyUnreadable, "stored key cannot be decrypted")
				st.status, st.feedLive = store.RemoteStatusKeyUnreadable, false
				changed = true
			}
			continue
		}
		if st.cancel == nil {
			if st.status == store.RemoteStatusKeyUnreadable || st.status == "" {
				st.status = rs.Status
				if st.status == "" || st.status == store.RemoteStatusKeyUnreadable {
					st.status = store.RemoteStatusUnknown
				}
			}
			wctx, cancel := context.WithCancel(ctx)
			st.cancel = cancel
			go func() { defer safego.Recover("background/remote_agents:h.pollLoop"); h.pollLoop(wctx, rs.ID) }()
			go func() { defer safego.Recover("background/remote_agents:h.feedLoop"); h.feedLoop(wctx, rs.ID) }()
			changed = true
		}
	}
	for id, st := range h.remotes {
		if !seen[id] {
			if st.cancel != nil {
				st.cancel()
			}
			delete(h.remotes, id)
			changed = true
		}
	}
	h.snap = nil // the registry rows (last seen, last error, label) are in the snapshot
	h.mu.Unlock()
	if changed {
		h.notify()
	}
}

// Subscribe implements RemoteAgentSource.
func (h *RemoteAgentHub) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	id := h.nextSub
	h.nextSub++
	h.subs[id] = ch
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, id)
		h.mu.Unlock()
	}
}

func (h *RemoteAgentHub) notify() {
	// Drop the cached snapshot before the generation moves, so a reader that
	// sees the new generation also gets data at least that new.
	h.mu.Lock()
	h.snap = nil
	h.mu.Unlock()
	h.gen.Add(1)
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (h *RemoteAgentHub) current(id string) (*remoteState, bool) {
	st, ok := h.remotes[id]
	return st, ok
}
