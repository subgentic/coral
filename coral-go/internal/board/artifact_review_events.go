package board

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// The for-review events of the live feed (#15996, coral-hub #208896): when an artifact is tagged or untagged "for review" the session feed to the Hub says so, so the Hub can show the artifact in its review
// list without refetching. The event is the artifact's id and tagged true/false, nothing else (no name, no text, no board).
//
// Many writers change the tag (a tag edit, a manifest, a send for review, a decision, ignore, supersede, a board made again), and each calls NoteArtifactsChanged once it has committed. So the events come from
// there: while a feed is attached, the set of artifacts carrying the tag is read again and compared with the one last seen, and each difference is one event. A write that leaves the tag as it was (a re-save of the
// same tags, a decision on a file that was never for review) is no event. The events are kept in memory: a restart ends the feed's connections too, and a Hub reads the artifacts again when it connects.

// forReviewKeep bounds the events held: a connection further behind than this is told it missed some (a gap) and reads the list again.
const forReviewKeep = 256

// ForReviewEvent is one tag or untag of "for review". Seq is this process's counter and never leaves it (the feed sends the other two fields).
type ForReviewEvent struct {
	Artifact string `json:"artifact"`
	Tagged   bool   `json:"tagged"`
	Seq      int64  `json:"-"`
}

type forReviewLog struct {
	watching atomic.Bool            // a feed has attached: until then nothing is read or kept
	notify   atomic.Pointer[func()] // told after an event is made, so the feed sends it now rather than at its next tick
	mu       sync.Mutex
	known    map[string]map[string]bool // board -> artifacts carrying the tag, as last read (valid once watching)
	seq      int64
	events   []ForReviewEvent
}

func (l *forReviewLog) add(artifact string, tagged bool) {
	l.seq++
	l.events = append(l.events, ForReviewEvent{Artifact: artifact, Tagged: tagged, Seq: l.seq})
	if len(l.events) > forReviewKeep {
		l.events = append([]ForReviewEvent(nil), l.events[len(l.events)-forReviewKeep:]...)
	}
}

// watchForReview starts the log: it reads who carries the tag now (no events for that) and from then on every NoteArtifactsChanged compares. Safe to call again.
func (s *Store) watchForReview(ctx context.Context) {
	l := &s.reviewLog
	if l.watching.Load() {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.watching.Load() {
		return
	}
	var rows []struct {
		Board string `db:"board_id"`
		Hex   string `db:"hex"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT board_id, hex FROM artifact_tags WHERE tag = ?`, tagForReview); err != nil {
		return // not watching: the next feed connection tries again, and no event is made from a failed read
	}
	l.known = map[string]map[string]bool{}
	for _, r := range rows {
		if l.known[r.Board] == nil {
			l.known[r.Board] = map[string]bool{}
		}
		l.known[r.Board][r.Hex] = true
	}
	l.watching.Store(true)
}

// noteForReviewChanged compares the board's artifacts carrying the tag with the set last seen, one event per difference. Called by NoteArtifactsChanged; a read that fails leaves the set as it was, so the
// difference is found by the next call.
func (s *Store) noteForReviewChanged(board string) {
	l := &s.reviewLog
	if board == "" || !l.watching.Load() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var hexes []string
	if err := s.reader().SelectContext(ctx, &hexes, `SELECT hex FROM artifact_tags WHERE board_id = ? AND tag = ? ORDER BY hex`, board, tagForReview); err != nil {
		return
	}
	l.mu.Lock()
	before := l.seq
	defer func() {
		moved := l.seq != before
		l.mu.Unlock()
		if f := l.notify.Load(); moved && f != nil {
			(*f)()
		}
	}()
	now := make(map[string]bool, len(hexes))
	for _, h := range hexes {
		now[h] = true
		if !l.known[board][h] {
			l.add(h, true)
		}
	}
	for h := range l.known[board] {
		if !now[h] {
			l.add(h, false)
		}
	}
	if len(now) == 0 {
		delete(l.known, board)
	} else {
		l.known[board] = now
	}
}

// SetForReviewNotify sets what is called (with no lock held) after a for-review event is made: the server wakes its feeds with it.
func (s *Store) SetForReviewNotify(f func()) {
	if f == nil {
		s.reviewLog.notify.Store(nil)
		return
	}
	s.reviewLog.notify.Store(&f)
}

// ForReviewSeq is the counter now, and starts the log if a feed is the first to ask: a feed connection starts from it and is told only what happens after.
func (s *Store) ForReviewSeq() int64 {
	s.watchForReview(context.Background())
	l := &s.reviewLog
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.seq
}

// ForReviewEventsSince is the events above seq, oldest first, the counter now, and whether some were missed (more happened than are kept).
func (s *Store) ForReviewEventsSince(seq int64) (events []ForReviewEvent, now int64, gap bool) {
	l := &s.reviewLog
	l.mu.Lock()
	defer l.mu.Unlock()
	now = l.seq
	if now <= seq {
		return nil, now, false
	}
	for _, e := range l.events {
		if e.Seq > seq {
			events = append(events, e)
		}
	}
	if len(events) == 0 || events[0].Seq != seq+1 {
		gap = true
	}
	return events, now, gap
}
