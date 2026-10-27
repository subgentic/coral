package testrig

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/runrecord"
	"github.com/subgentic/coral/internal/updater/stage"
	"github.com/subgentic/coral/internal/updater/verify"
)

// #9063: a status read (what "coral-update status" does: the state file, the run record, the lock files, all read-only) made while a check runs must not disturb it. The reads run as fast as
// they can through every check of a world that moves: a release staged, found again, a newer one staged.
func TestStatusReadsDuringACheckNeverDisturbIt(t *testing.T) {
	r := newRig(t)
	dir := filepath.Join(r.cfg.DataDir, stage.UpdatesDir)
	require.NoError(t, runrecord.Write(r.cfg.DataDir, []string{"/opt/coral/coral", "--port", "8420"}, []string{"PATH=/usr/bin"}, "/srv"))
	var stop atomic.Bool
	var reads, bad atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for !stop.Load() {
				if _, err := verify.LoadState(dir); err != nil {
					bad.Add(1)
				}
				_, _ = os.Lstat(filepath.Join(dir, verify.StateFile))
				_, _ = verify.ReadPrivate(filepath.Join(dir, runrecord.File))
				_ = stage.CheckRunning(dir, time.Now())
				_, _ = stage.LoadStaged(r.cfg.DataDir)
				reads.Add(1)
			}
		}()
	}
	defer func() { stop.Store(true); wg.Wait() }()
	r.publish(Spec{Version: "1.4.131", Sequence: 7})
	for i, want := range []string{stage.ResultStaged, stage.ResultAlreadyStaged, stage.ResultAlreadyStaged} {
		res := r.check()
		require.Equal(t, want, res.Result, "check %d: %+v", i, res)
	}
	r.publish(Spec{Version: "1.4.132", Sequence: 8})
	res := r.check()
	require.Equal(t, stage.ResultStaged, res.Result, "%+v", res)
	stop.Store(true)
	wg.Wait()
	assert.Zero(t, bad.Load(), "no read of the state failed while it was being rewritten")
	assert.Positive(t, reads.Load())
}
