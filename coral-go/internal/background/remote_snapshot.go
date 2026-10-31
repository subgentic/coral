// The hub's snapshot of its remote servers and their agents: the RemoteSnapshot type, its JSON encodings and RemoteAgentHub.Snapshot. Moved out of remote_agents.go (#8259), no code changed.

package background

import (
	"encoding/json"
	"sort"
	"sync"

	"github.com/subgentic/coral/internal/store"
)

// RemoteSnapshot is a point-in-time view of all remote data. Sessions are
// already tagged with "server" (and "stale" when applicable). A snapshot is
// built once per change and shared by every caller until the next one, so it
// is READ-ONLY: do not modify its slices or maps (copy an entry first).
type RemoteSnapshot struct {
	Servers  []RemoteServerStatus
	Sessions []map[string]any

	enc *snapshotEncoding // per-snapshot cache of the encoded sessions
}

type snapshotEncoding struct {
	once     sync.Once
	sessions []json.RawMessage
}

// SessionsJSON returns each of Sessions encoded as JSON (encoding/json, as
// the HTTP and WS writers use), computed once per snapshot.
func (s RemoteSnapshot) SessionsJSON() []json.RawMessage {
	encode := func() []json.RawMessage {
		out := make([]json.RawMessage, len(s.Sessions))
		for i, sess := range s.Sessions {
			out[i], _ = json.Marshal(sess)
		}
		return out
	}
	if s.enc == nil {
		return encode()
	}
	s.enc.once.Do(func() { s.enc.sessions = encode() })
	return s.enc.sessions
}

// Configured reports whether any remote is registered.
func (s RemoteSnapshot) Configured() bool { return len(s.Servers) > 0 }

// Snapshot returns the current merged remote view, ordered by server id.
func (h *RemoteAgentHub) Snapshot() RemoteSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.snap != nil {
		return *h.snap
	}
	ids := make([]string, 0, len(h.remotes))
	for id := range h.remotes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var snap RemoteSnapshot
	for _, id := range ids {
		st := h.remotes[id]
		status := st.status
		if status == "" {
			status = store.RemoteStatusUnknown
		}
		label := st.srv.Label
		if label == "" {
			label = id
		}
		entry := RemoteServerStatus{ID: id, Label: label, Status: status, URL: st.srv.URL, Agents: countUnarchived(st.sessions), Version: st.version, OwnerStamp: st.ownerStamp && st.srv.OwnerStamp}
		if st.srv.LastSeen != nil {
			entry.LastSeen = *st.srv.LastSeen
		}
		if st.srv.LastError != nil && status != store.RemoteStatusOnline {
			entry.LastError = *st.srv.LastError
		}
		snap.Servers = append(snap.Servers, entry)
		for _, s := range st.sessions {
			c := make(map[string]any, len(s)+2)
			for k, v := range s {
				c[k] = v
			}
			c["server"] = id
			// Always explicit: a dashboard merges each diff into the session it
			// has and keeps keys a diff omits, so a deleted "stale" would leave a
			// recovered agent stale until a reload (#3159).
			c["stale"] = status != store.RemoteStatusOnline
			snap.Sessions = append(snap.Sessions, c)
		}
	}
	snap.enc = &snapshotEncoding{}
	h.snap = &snap
	return snap
}

// NewRemoteSnapshot builds a snapshot from already tagged sessions, for
// RemoteAgentSource implementations other than the hub (tests, fakes). Like
// the hub's, it caches its encoded sessions and must be treated as read-only.
// NewRemoteSnapshot has no production caller: it is exported for the remote-list benchmark test in internal/server/routes.
func NewRemoteSnapshot(servers []RemoteServerStatus, sessions []map[string]any) RemoteSnapshot {
	return RemoteSnapshot{Servers: servers, Sessions: sessions, enc: &snapshotEncoding{}}
}
