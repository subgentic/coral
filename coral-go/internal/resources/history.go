package resources

import (
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/pkg/resourcequeue"
)

// HistoryDays is how long the record of the queue's use is kept (#13671).
const HistoryDays = 90

const historyBuffer = 512

// History is the record of the queue's use, a small SQLite file of its own next to the queue's state file (#13671, the Operator's analytics): one row per change, with the agent's name, the resource, the
// times and the hook's pattern. It never holds a command, a note, a path or any board text. It is best effort by design: an event is queued and written by one goroutine, a full queue drops the event and
// counts it, and a file that cannot be opened or written loses analytics only. Nothing here may delay or fail a claim.
type History struct {
	db      *sql.DB
	ch      chan resourcequeue.Event
	wg      sync.WaitGroup
	dropped atomic.Int64
	pending atomic.Int64
	mu      sync.RWMutex // Add holds it shared while it sends; Close takes it to close the channel, so nothing sends on a closed one
	closed  bool

	path      string
	writeGate func() // tests: stands in for a stuck file
}

// private sets the file and its sidecars to the owner alone (a no-op for what does not exist; not the permission model on Windows).
func (h *History) private() {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Chmod(h.path+suffix, 0o600)
	}
}

// prune removes the rows older than HistoryDays: at open, and once a day while the writer runs.
func (h *History) prune(now time.Time) {
	_, _ = h.db.Exec(`DELETE FROM resource_events WHERE at < ?`, now.Add(-HistoryDays*24*time.Hour).UnixMilli())
}

// OpenHistory opens (and makes) the file and starts its writer. Rows older than HistoryDays are removed.
func OpenHistory(path string) (*History, error) {
	if f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600); err != nil { // made private before SQLite opens it (it makes its -wal and -shm with the file's mode)
		return nil, err
	} else {
		_ = f.Close()
	}
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(2000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS resource_events (
		at INTEGER NOT NULL, kind TEXT NOT NULL, resource TEXT NOT NULL, agent TEXT NOT NULL, task INTEGER NOT NULL DEFAULT 0,
		entry INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT '', pattern TEXT NOT NULL DEFAULT '', wait_ms INTEGER NOT NULL DEFAULT 0, held_ms INTEGER NOT NULL DEFAULT 0);
		CREATE INDEX IF NOT EXISTS resource_events_at ON resource_events(at)`); err != nil {
		_ = db.Close()
		return nil, err
	}
	h := &History{db: db, ch: make(chan resourcequeue.Event, historyBuffer), path: path}
	h.prune(time.Now())
	h.private()
	h.wg.Add(1)
	go func() {
		defer safego.Recover("resources/history") // a panic in the writer loses analytics, never the server
		h.run()
	}()
	return h, nil
}

func (h *History) run() {
	defer h.wg.Done()
	daily := time.NewTicker(24 * time.Hour)
	defer daily.Stop()
	for {
		var e resourcequeue.Event
		select {
		case <-daily.C:
			h.prune(time.Now())
			continue
		case ev, ok := <-h.ch:
			if !ok {
				return
			}
			e = ev
		}
		if h.writeGate != nil {
			h.writeGate()
		}
		_, err := h.db.Exec(`INSERT INTO resource_events (at, kind, resource, agent, task, entry, via, pattern, wait_ms, held_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`,
			e.At.UnixMilli(), e.Kind, e.Resource, e.Agent, e.Task, e.Entry, e.Via, e.Pattern, e.Wait.Milliseconds(), e.Held.Milliseconds())
		if err != nil {
			slog.Warn("resource history write failed", "error", err) // the detail is the log's; the queue goes on
			h.dropped.Add(1)
		}
		h.pending.Add(-1)
	}
}

// Add queues an event and returns at once; with the queue full the event is dropped and counted. It is the queue's OnEvent.
func (h *History) Add(e resourcequeue.Event) {
	if h == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.closed {
		return // closed: the event is not kept, and nothing panics
	}
	h.pending.Add(1)
	select {
	case h.ch <- e:
	default:
		h.pending.Add(-1)
		h.dropped.Add(1)
	}
}

// Dropped is the number of events that were not kept (a full queue or a failed write) since the file was opened.
func (h *History) Dropped() int64 {
	if h == nil {
		return 0
	}
	return h.dropped.Load()
}

// Flush waits until what is queued has been written (tests, and a read that wants the latest).
func (h *History) Flush() {
	if h == nil {
		return
	}
	for i := 0; i < 2000 && h.pending.Load() > 0; i++ {
		time.Sleep(5 * time.Millisecond) // sleep-ok: a poll of the writer's counter for tests and the read; a few ms steps, 10 s at most
	}
}

// Close writes what is queued and closes the file.
func (h *History) Close() {
	if h == nil {
		return
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	close(h.ch)
	h.mu.Unlock()
	h.wg.Wait()
	_ = h.db.Close()
}

// Events reads the rows with since <= at < until, oldest first.
func (h *History) Events(since, until time.Time) ([]resourcequeue.Event, error) {
	if h == nil {
		return nil, fmt.Errorf("resources: no history")
	}
	rows, err := h.db.Query(`SELECT at, kind, resource, agent, task, entry, via, pattern, wait_ms, held_ms FROM resource_events WHERE at >= ? AND at < ? ORDER BY at, rowid`, since.UnixMilli(), until.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []resourcequeue.Event
	for rows.Next() {
		var e resourcequeue.Event
		var at, wait, held int64
		if err := rows.Scan(&at, &e.Kind, &e.Resource, &e.Agent, &e.Task, &e.Entry, &e.Via, &e.Pattern, &wait, &held); err != nil {
			return nil, err
		}
		e.At, e.Wait, e.Held = time.UnixMilli(at).UTC(), time.Duration(wait)*time.Millisecond, time.Duration(held)*time.Millisecond
		out = append(out, e)
	}
	return out, rows.Err()
}
