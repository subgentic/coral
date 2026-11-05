package board

import (
	"sync"
	"sync/atomic"
	"time"
)

// A new store gets a new epoch, including when a database is reopened in the
// same process. Values stay within JavaScript's exact integer range. Revisions
// are freshness hints, not persisted business state.
var artifactEpoch atomic.Uint64

type artifactRevisions struct {
	mu     sync.Mutex
	epoch  uint64
	boards map[string]uint64
}

func (r *artifactRevisions) init() {
	if r.boards != nil {
		return
	}
	for {
		old := artifactEpoch.Load()
		next := uint64(time.Now().UnixMicro())
		if next <= old {
			next = old + 1
		}
		if artifactEpoch.CompareAndSwap(old, next) {
			r.epoch = next
			break
		}
	}
	r.boards = make(map[string]uint64)
}

// ArtifactsRevision returns a board's current artifact-list freshness token.
// A list captures this BEFORE reading its data: a concurrent mutation must
// leave the response older than the next status/feed token, never newer.
func (s *Store) ArtifactsRevision(board string) uint64 {
	r := &s.artifactsRevision
	r.mu.Lock()
	defer r.mu.Unlock()
	r.init()
	if n, ok := r.boards[board]; ok {
		return n
	}
	r.boards[board] = r.epoch
	return r.epoch
}

// NoteArtifactsChanged follows a successful mutation affecting the board's
// artifact list. It cannot fail after the business write has committed.
func (s *Store) NoteArtifactsChanged(board string) {
	r := &s.artifactsRevision
	r.mu.Lock()
	defer r.mu.Unlock()
	r.init()
	n, ok := r.boards[board]
	if !ok {
		n = r.epoch
	}
	r.boards[board] = n + 1
	if board != "" {
		all, ok := r.boards[""]
		if !ok {
			all = r.epoch
		}
		r.boards[""] = all + 1
	}
}

// ArtifactRevisions snapshots boards observed by an artifact/status reader or
// writer. A newly visited board gets its initial token in its HTTP response.
func (s *Store) ArtifactRevisions() map[string]uint64 {
	r := &s.artifactsRevision
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]uint64, len(r.boards))
	for b, n := range r.boards {
		out[b] = n
	}
	return out
}

// NoteAllArtifactsChanged invalidates every observed board after an object-wide
// mutation (delete, comments or stars): the same digest can be on several teams.
func (s *Store) NoteAllArtifactsChanged() {
	r := &s.artifactsRevision
	r.mu.Lock()
	defer r.mu.Unlock()
	r.init()
	for b, n := range r.boards {
		r.boards[b] = n + 1
	}
	if _, ok := r.boards[""]; !ok {
		r.boards[""] = r.epoch + 1
	}
}
