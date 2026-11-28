package background

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store/storetest"
)

// #22119: each prune batch is checkpointed as it goes, so the WAL never collects the megabytes that one write would then have to copy and sync (2.29 s on a slow Windows disk).
// The WAL's size does not depend on the disk's speed, so it is what this test bounds: SQLite's automatic checkpoint lets it reach about 4 MB.
func TestAPruneKeepsTheWALSmallSoNoWriteCopiesMegabytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := storetest.Open(t, path)
	require.NoError(t, err)
	_, err = db.Exec(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 150000)
		INSERT INTO call_metrics_hourly(hour, call_type, operation, agent_name, calls) SELECT '2020-01-01T00', 'api', 'op', 'a' || i, 1 FROM c`)
	require.NoError(t, err)
	_, err = db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	require.NoError(t, err)
	j := NewCallMetricsRetention(db)
	j.BatchSize, j.Pause = 2000, 5*time.Millisecond

	stop := make(chan struct{})
	res := make(chan int64, 1)
	go func() {
		var most int64
		for {
			select {
			case <-stop:
				res <- most
				return
			default:
			}
			_, _ = db.Exec(`INSERT INTO call_metrics(call_type, operation, method, created_at) VALUES ('api', '/x', 'GET', ?)`, time.Now().UTC().Format(time.RFC3339Nano))
			if fi, err := os.Stat(path + "-wal"); err == nil && fi.Size() > most {
				most = fi.Size()
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	j.RunOnce(context.Background())
	close(stop)
	most := <-res
	var left int
	require.NoError(t, db.Get(&left, `SELECT COUNT(*) FROM call_metrics_hourly`))
	assert.Zero(t, left, "every expired hourly row went")
	assert.Less(t, most, int64(1<<20), "the WAL stayed under 1 MiB while 150000 rows were pruned (about 4 MB without a checkpoint per batch)")
}
