// The hub's upstream feed of one remote server (/ws/coral): the loop, its key, the socket reader and the keepalive pings. Moved out of remote_agents.go (#8259), no code changed.

package background

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// feedLoop maintains the upstream /ws/coral socket for one remote while the
// remote is online, with reconnect backoff.
func (h *RemoteAgentHub) feedLoop(ctx context.Context, id string) {
	backoff := h.cfg.MinBackoff
	for {
		h.mu.Lock()
		st, ok := h.current(id)
		online := ok && st.status == store.RemoteStatusOnline
		h.mu.Unlock()
		if !ok {
			return
		}
		if online {
			started := time.Now()
			h.runFeed(ctx, id)
			if ctx.Err() != nil {
				return
			}
			if time.Since(started) > 10*time.Second {
				backoff = h.cfg.MinBackoff
			}
		}
		if !SleepCtx(ctx, backoff) {
			return
		}
		if backoff *= 2; backoff > h.cfg.MaxBackoff {
			backoff = h.cfg.MaxBackoff
		}
	}
}

func FeedKey(s map[string]any) string {
	if sid, _ := s["session_id"].(string); sid != "" {
		return sid
	}
	name, _ := s["name"].(string)
	return name
}

func (h *RemoteAgentHub) runFeed(ctx context.Context, id string) {
	t, err := h.resolver.Resolve(ctx, id)
	if err != nil {
		return
	}
	dctx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	// feed=hub: this is a machine feed, not a dashboard, so the remote keeps
	// its UI notifications for its own dashboards (see routes WSCoral).
	conn, err := proxy.DialWebSocket(dctx, t, "/ws/coral", "feed=hub", nil)
	cancel()
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(32 << 20)
	fctx, stopFeed := context.WithCancel(ctx)
	defer stopFeed()
	if p, ok := conn.(feedPinger); ok {
		go func() { defer safego.Recover("background/remote_agents:h.pingFeed"); h.pingFeed(fctx, conn, p) }()
	}

	rows := newRemoteRows()
	defer func() {
		h.mu.Lock()
		if st, ok := h.current(id); ok {
			st.feedLive = false
		}
		h.mu.Unlock()
	}()
	for {
		_, data, err := conn.Read(fctx)
		if err != nil {
			if websocket.CloseStatus(err) == -1 && ctx.Err() == nil {
				h.logger.Debug("remote feed dropped", "server", id)
			}
			return
		}
		// Any message (coral_heartbeat included) shows the remote's feed loop
		// is alive, so the list does not need re-polling.
		h.mu.Lock()
		if st, ok := h.current(id); ok {
			st.feedMsgAt = time.Now()
		}
		h.mu.Unlock()
		// The rows stay raw until each has been measured: one over the limit is never decoded into the hub's memory (decodeLocalRow).
		var msg struct {
			Type     string            `json:"type"`
			Sessions []json.RawMessage `json:"sessions"`
			Changed  []json.RawMessage `json:"changed"`
			Removed  []string          `json:"removed"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "coral_update":
			rows.reset()
			for _, raw := range msg.Sessions {
				rows.add(raw)
			}
		case "coral_diff":
			for _, raw := range msg.Changed {
				rows.add(raw)
			}
			for _, k := range msg.Removed {
				rows.remove(k)
			}
		default:
			continue
		}
		sessions := rows.sessions()
		sig := rows.signature()
		h.mu.Lock()
		st, ok := h.current(id)
		if !ok {
			h.mu.Unlock()
			return
		}
		changed := !st.feedLive || sig != st.lastSig
		st.feedLive = true
		st.lastSig = sig
		st.sessions = sessions
		h.mu.Unlock()
		if changed {
			h.notify()
		}
	}
}

// feedPinger is implemented by sockets that support websocket pings
// (*websocket.Conn). Tunnel sockets do not; their feed relies on the quiet
// refresh and the remote closing the stream.
type feedPinger interface {
	Ping(ctx context.Context) error
}

// pingFeed pings the upstream feed every FeedPingInterval and drops the socket when
// two pings in a row are not answered within RequestTimeout (a half-open
// connection or a remote that stopped reading; one slow answer over a port
// forward is tolerated, #3649). Dropping it only ends feedLive: the poll goes
// back to fetching the list, which decides the remote's status.
func (h *RemoteAgentHub) pingFeed(ctx context.Context, conn proxy.WSConn, p feedPinger) {
	missed := 0
	t := time.NewTicker(h.cfg.FeedPingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pctx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
		err := p.Ping(pctx)
		cancel()
		if err == nil {
			missed = 0
			continue
		}
		// A ping cut short by the feed's own end is not a miss: the feed is closing anyway,
		// and the ctx.Done branch above leaves the close to the caller too.
		if ctx.Err() != nil {
			return
		}
		if missed++; missed < 2 {
			continue
		}
		h.logger.Debug("remote feed ping failed twice; dropping feed", "error", err)
		conn.CloseNow()
		return
	}
}
