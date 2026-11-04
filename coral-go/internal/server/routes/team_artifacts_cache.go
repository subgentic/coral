package routes

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// The team's artifact list is built from the tasks' results, the upload records, the cross-team rows, the tags and the upload-task links (projectArtifactItems), and every request used to build
// it again before it cut one page: Needs you reads a board of 20,000 files a page of 200 at a time, so 100 builds in a row, 14 s (#13522). The built list is kept for the walk.
//
// What the key says: the board's ArtifactsRevision (read BEFORE the data, so a write during the build leaves the entry older than the next token and it is built again), the session filter, the
// team's subscriber sessions and the modification times of their upload folders (a record written outside the upload route moves a folder's time). teamItemsTTL is the last word: an entry is
// never used past it, whatever moved or did not, so a writer that forgot to note a change shows within a few seconds. What it does NOT hold is what depends on the caller or on settings that do not
// move the revision: the new-comments counts, the kinds and what is muted (the Operator's settings), the read check and the private marks. They are applied to a copy, on every request.
const (
	teamItemsTTL     = 5 * time.Second
	teamItemsEntries = 4
)

// teamItemsBuildHook runs once for each build of the list (tests count them: a walk of the pages builds once).
var teamItemsBuildHook = func() {}

type teamItemsKey struct {
	project, session string
	rev              uint64
	subscribers      string // the subscriber sessions, and the time of each one's upload folder
}

type teamItemsEntry struct {
	key       teamItemsKey
	at        time.Time
	items     []teamArtifact
	truncated bool
}

type teamItemsCache struct {
	mu      sync.Mutex
	entries []*teamItemsEntry // newest first
	now     func() time.Time  // a test's clock; nil is time.Now
}

func (c *teamItemsCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// get is a copy of the entry for key, or false (a copy: the caller applies its own parts to it).
func (c *teamItemsCache) get(key teamItemsKey) ([]teamArtifact, bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, e := range c.entries {
		if e.key != key {
			continue
		}
		if c.clock().Sub(e.at) > teamItemsTTL {
			c.entries = append(c.entries[:i], c.entries[i+1:]...)
			return nil, false, false
		}
		return append([]teamArtifact(nil), e.items...), e.truncated, true
	}
	return nil, false, false
}

// put keeps items (the caller keeps its own copy) under key and drops the entries of the same board and filter that an older revision made, and the oldest beyond teamItemsEntries.
func (c *teamItemsCache) put(key teamItemsKey, items []teamArtifact, truncated bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := c.entries[:0:0]
	for _, e := range c.entries {
		if e.key.project == key.project && e.key.session == key.session {
			continue
		}
		kept = append(kept, e)
	}
	e := &teamItemsEntry{key: key, at: c.clock(), items: append([]teamArtifact(nil), items...), truncated: truncated}
	c.entries = append([]*teamItemsEntry{e}, kept...)
	if len(c.entries) > teamItemsEntries {
		c.entries = c.entries[:teamItemsEntries]
	}
}

// teamItemsSubscribers is the key's account of the team's subscribers (name -> session id): each pair and the modification time of the session's upload folder (not there: 0). The sessions that only
// a task names are not in it: their uploads reach the list through the revision (the upload route notes it) or, for a record written outside it, the TTL.
func (h *BoardHandler) teamItemsSubscribers(subscribers map[string]string) string {
	names := make([]string, 0, len(subscribers))
	for name := range subscribers {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, name := range names {
		sid := subscribers[name]
		var mod int64
		if dir := uploadsDir(h.coralDir, sid); dir != "" {
			if st, err := os.Stat(dir); err == nil {
				mod = st.ModTime().UnixNano()
			}
		}
		fmt.Fprintf(&b, "%s=%s@%d;", name, sid, mod)
	}
	return b.String()
}
