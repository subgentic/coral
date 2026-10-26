package store

import (
	"sync/atomic"

	"github.com/jmoiron/sqlx"
)

// TaskStore provides agent tasks, notes, and events operations.
type TaskStore struct {
	db *DB
	// eventKeep is how many events InsertAgentEvent keeps per session (0: agentEventKeep).
	// Atomic, so a test can set it while the server is serving.
	eventKeep atomic.Int64
}

// agentEventKeep is how many agent events are kept per session.
const agentEventKeep = 500

// SetEventKeep changes how many events this store keeps per session; tests use it to reach the
// pruning without inserting hundreds of events.
// SetEventKeep has no production caller: it is exported for the session-state sequence test in internal/server/routes.
func (s *TaskStore) SetEventKeep(n int) { s.eventKeep.Store(int64(n)) }

// NewTaskStore creates a new TaskStore.
func NewTaskStore(db *DB) *TaskStore {
	return &TaskStore{db: db}
}

func (s *TaskStore) reader() *sqlx.DB {
	return s.db.Reader()
}
