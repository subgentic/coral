// The rows of one remote server's agents: the row store and the parsing and bounding of a live list. Moved out of remote_agents.go (#8259), no code changed.

package background

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
)

// parseLiveList accepts the plain array form and the {"sessions":[...]} form
// (a remote that is itself a hub), dropping entries that belong to servers
// other than the remote itself, and bounding what is kept (boundRemoteList).
func parseLiveList(body []byte) ([]map[string]any, error) {
	var list []json.RawMessage
	if err := json.Unmarshal(body, &list); err != nil {
		var obj struct {
			Sessions []json.RawMessage `json:"sessions"`
		}
		if err2 := json.Unmarshal(body, &obj); err2 != nil {
			return nil, errors.New("remote returned an invalid session list")
		}
		list = obj.Sessions
	}
	return boundRemoteList(list), nil
}

// What the hub keeps of ONE remote machine's sessions, from its list or its feed (#5099): a machine that is not the Operator's own (a compromised one, a hub
// registered as a machine) could otherwise grow the hub's memory without bound. The count alone is not a bound, a row can be megabytes (the message limit is
// 32 MiB), so three limits hold: the sessions, one row's size as the machine sent it, and the sum of the sizes of the rows kept. A real row is a few KiB, a long
// prompt tens of KiB. The budget is 16 MiB of the rows as sent: decoded into maps they cost about 7.5 times that in memory (QA, #5099).
const (
	maxRemoteSessions = 5000
	maxRemoteRowBytes = 256 << 10
	maxRemoteBytes    = 16 << 20
)

// decodeLocalRow is one session row of a machine's list or feed: nil when it is over the row limit, does not parse, or belongs to another server than the
// machine itself (a hub registered as a machine lists its own machines' rows; they are not this machine's).
func decodeLocalRow(raw json.RawMessage) map[string]any {
	if len(raw) > maxRemoteRowBytes {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return nil
	}
	if sv, _ := m["server"].(string); sv != "" && sv != "local" {
		return nil
	}
	return m
}

// boundRemoteList is the rows of a machine's list within the three limits, in order: a row that is another server's, over the row limit or past the byte budget is
// skipped (a later, smaller row may still fit), and the list stops at the count.
func boundRemoteList(raws []json.RawMessage) []map[string]any {
	out := make([]map[string]any, 0, min(len(raws), maxRemoteSessions))
	total := 0
	for _, raw := range raws {
		if len(out) >= maxRemoteSessions {
			break
		}
		if total+len(raw) > maxRemoteBytes {
			continue
		}
		if m := decodeLocalRow(raw); m != nil {
			total += len(raw)
			out = append(out, m)
		}
	}
	return out
}

// remoteRows is the sessions a machine's feed has told the hub about, within the same limits, with a signature kept as rows come and go so a message does not
// cost a re-encoding of everything held (what the hub spent per message before: every row, each time).
type remoteRows struct {
	rows  map[string]remoteRow
	order []string
	bytes int
	sum   uint64
}

type remoteRow struct {
	m    map[string]any
	size int
	sum  uint64
}

func newRemoteRows() *remoteRows { return &remoteRows{rows: map[string]remoteRow{}} }

func (r *remoteRows) reset() {
	r.rows, r.order, r.bytes, r.sum = map[string]remoteRow{}, r.order[:0], 0, 0
}

func rowSum(key string, raw []byte) uint64 {
	h := fnv.New64a()
	h.Write([]byte(key))
	h.Write([]byte{0})
	h.Write(raw)
	return h.Sum64()
}

// add records one session of the feed under its key (a session's id, else its name), in arrival order, and reports whether it was kept. A row that is over the
// row limit takes its key's old row out (the machine says it is something the hub will not hold); one that would pass the count or the byte budget is left out and
// the old one stays.
func (r *remoteRows) add(raw json.RawMessage) bool {
	m := decodeLocalRow(raw)
	if m == nil {
		if len(raw) > maxRemoteRowBytes {
			var id struct {
				SessionID string `json:"session_id"`
				Name      string `json:"name"`
			}
			if json.Unmarshal(raw, &id) == nil {
				k := id.SessionID
				if k == "" {
					k = id.Name
				}
				r.remove(k)
			}
		}
		return false
	}
	k := FeedKey(m)
	if k == "" {
		return false
	}
	old, exists := r.rows[k]
	if !exists && len(r.rows) >= maxRemoteSessions {
		return false
	}
	if r.bytes-old.size+len(raw) > maxRemoteBytes {
		return false
	}
	if !exists {
		r.order = append(r.order, k)
	}
	row := remoteRow{m: m, size: len(raw), sum: rowSum(k, raw)}
	r.bytes += row.size - old.size
	r.sum += row.sum - old.sum
	r.rows[k] = row
	return true
}

func (r *remoteRows) remove(k string) {
	if old, ok := r.rows[k]; ok {
		r.bytes -= old.size
		r.sum -= old.sum
		delete(r.rows, k)
	}
}

// sessions is the held rows in arrival order (a key removed and added again counts where it came back).
func (r *remoteRows) sessions() []map[string]any {
	out := make([]map[string]any, 0, len(r.rows))
	kept := r.order[:0]
	seen := make(map[string]bool, len(r.rows))
	for _, k := range r.order {
		if row, ok := r.rows[k]; ok && !seen[k] {
			seen[k] = true
			kept = append(kept, k)
			out = append(out, row.m)
		}
	}
	r.order = kept
	return out
}

// signature changes when a row is added, replaced with other content or removed.
func (r *remoteRows) signature() string { return fmt.Sprintf("feed:%d:%x", len(r.rows), r.sum) }

func sessionsSig(s []map[string]any) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// countUnarchived is the server's agent count: archived agents are kept out of
// it, as they are out of the agent list (#3030).
func countUnarchived(sessions []map[string]any) int {
	n := 0
	for _, s := range sessions {
		if s["archived"] != true {
			n++
		}
	}
	return n
}
