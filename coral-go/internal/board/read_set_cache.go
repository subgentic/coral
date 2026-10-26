package board

import (
	"context"
	"sync"
	"sync/atomic"
)

// readSetCache remembers each member's read set between dock polls (#8525). ReadSetIDs scanned the whole board for the member on every list, search and dock poll (1.17 s on a board of 20,000
// tagged messages, Security's cost note on #8484); a message is selected for a member by its own text and the member's rule, so a set already found stays right until the rule or the board's
// messages change, and the next call need only look at what is new. An entry is used only while it carries what it was made from:
//   - the member's rule: the subscriber's job title and whether it is read by tags (a receive mode of "none" is an empty set, kept as such);
//   - the board's numbered agent names (the tag rule reads them): numbered.gen, which every change of subscribers bumps;
//   - the deletions: a message that was deleted would stay in the set, so DeleteMessage bumps gen (and deleting a board bumps the numbered one).
//
// A message is never edited into or out of a member's set (a message's text is not rewritten), so none of that is needed for an edit.
type readSetCache struct {
	gen     atomic.Uint64 // bumped by a delete of a message
	mu      sync.Mutex
	entries map[string]readSetEntry

	scans atomic.Int64 // batches of the scan that ran (tests check a second poll scans only what is new)
}

// readSetCacheLimit is a count of members, not of bytes: an entry is 8 bytes an id, so 256 members on boards of 200,000 selected messages would be about 400 MB at the very worst; a real board has a handful of members and thousands of messages, and the map is dropped when full.
const readSetCacheLimit = 256

type readSetEntry struct {
	project, subscriberID string
	jobTitle              string
	tagged, none          bool
	numberedGen, gen      uint64

	boardMax int64   // the newest message id of the board when the scan started: a board still at it has nothing new
	upTo     int64   // the scan went on from here: the last candidate it examined
	read     []int64 // the selected ids up to upTo, oldest first (never written to: an extension copies)
	own      []int64 // the member's own posts up to boardMax
}

// invalidate drops what the cache holds, for a delete that changes what a set held.
func (c *readSetCache) invalidate() { c.gen.Add(1) }

func readSetKey(project, subscriberID string) string { return project + "\x00" + subscriberID }

func (c *readSetCache) get(project, subscriberID string, rule *readRule, numberedGen uint64) (readSetEntry, bool) {
	c.mu.Lock()
	e, ok := c.entries[readSetKey(project, subscriberID)]
	c.mu.Unlock()
	if !ok || e.jobTitle != rule.jobTitle || e.tagged != rule.tagged || e.none != rule.none || e.numberedGen != numberedGen || e.gen != c.gen.Load() {
		return readSetEntry{}, false
	}
	return e, true
}

func (c *readSetCache) put(e readSetEntry) {
	c.mu.Lock()
	if c.entries == nil || len(c.entries) >= readSetCacheLimit {
		c.entries = make(map[string]readSetEntry)
	}
	c.entries[readSetKey(e.project, e.subscriberID)] = e
	c.mu.Unlock()
}

// boardMaxMessageID is the newest message id of the board, 0 for none.
func (s *Store) boardMaxMessageID(ctx context.Context, project string) (int64, error) {
	var max int64
	err := s.reader().GetContext(ctx, &max, "SELECT COALESCE(MAX(id), 0) FROM board_messages WHERE project = ?", project)
	return max, err
}
