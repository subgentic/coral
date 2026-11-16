package routes

import (
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/cloud"
)

// The cross-team list read for its count alone (#18623): the dashboard asks GET /api/team-artifacts?...&limit=1 on its first load (the Inbox's counts) and again on each tick, and every ask walked every team's
// rows, merged them and filtered them to answer one number. The whole answer is kept per (artifacts revision, query, who is asking) for a few seconds: a write that moves the revision (an upload, a tag, a
// send, a delete) is a new key, and the seconds are the last word for what does not move it (new comments, the settings that mute a kind, a file taken off the disk), as for the per-team list (teamItemsTTL).
const (
	allCountTTL     = 5 * time.Second
	allCountEntries = 16
)

type allCountKey struct {
	rev      uint64
	query    string
	person   string
	owner    bool // sees the private marks
	key      bool // the Operator's own or a key's call: the comment news and kinds apply
	tunneled bool // a Hub viewer's rows are redacted
}

type allCountEntry struct {
	key  allCountKey
	at   time.Time
	resp map[string]any // read-only: only ever marshalled
}

type allCountCache struct {
	mu      sync.Mutex
	entries []*allCountEntry // newest first
}

// countKeyFor is the key of a request that asks for the count alone (one row, the first page), or false: a page of rows, a cursor or an offset is never kept.
func countKeyFor(r *http.Request, rev uint64, query string, limit, offset int, cursor bool) (allCountKey, bool) {
	if limit != 1 || offset != 0 || cursor {
		return allCountKey{}, false
	}
	return allCountKey{rev: rev, query: query, person: openedPersonKey(r), owner: ownerSeesPrivateMarks(r), key: operatorOrKeyCaller(r), tunneled: cloud.Tunneled(r)}, true
}

func (c *allCountCache) get(k allCountKey, now time.Time) (map[string]any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, e := range c.entries {
		if e.key != k {
			continue
		}
		if now.Sub(e.at) > allCountTTL {
			c.entries = append(c.entries[:i], c.entries[i+1:]...)
			return nil, false
		}
		return e.resp, true
	}
	return nil, false
}

func (c *allCountCache) put(k allCountKey, at time.Time, resp map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := c.entries[:0:0]
	for _, e := range c.entries {
		if e.key != k && e.key.rev == k.rev { // an older revision's answers are never asked again
			kept = append(kept, e)
		}
	}
	c.entries = append([]*allCountEntry{{key: k, at: at, resp: resp}}, kept...)
	if len(c.entries) > allCountEntries {
		c.entries = c.entries[:allCountEntries]
	}
}
