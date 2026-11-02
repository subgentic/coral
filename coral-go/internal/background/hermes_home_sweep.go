package background

import (
	"context"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/agent"
)

// HermesHomeSweep removes the Hermes homes no session record reaches and that are over a day old (#11949, Security's SHOULD on #11936): a minute after startup (the records are loaded by then), then daily.
// Each home holds a copy of the person's .env, so a home left by a launch that failed, a crash or a record deleted by hand is not kept. A sleeping agent's record counts: its home is how it is woken into its
// conversation.
type HermesHomeSweep struct {
	dataDir string
	liveIDs func(ctx context.Context) (map[string]bool, error)
	logger  *slog.Logger
	now     func() time.Time

	FirstRun, Interval, MinAge time.Duration
}

// NewHermesHomeSweep returns the job for a data folder and a source of every live or sleeping session id.
func NewHermesHomeSweep(dataDir string, liveIDs func(ctx context.Context) (map[string]bool, error)) *HermesHomeSweep {
	return &HermesHomeSweep{dataDir: dataDir, liveIDs: liveIDs, logger: slog.Default(), now: time.Now, FirstRun: time.Minute, Interval: 24 * time.Hour, MinAge: 24 * time.Hour}
}

// Run sweeps FirstRun after startup, then every Interval, until ctx is done.
func (j *HermesHomeSweep) Run(ctx context.Context) error {
	return runEvery(ctx, j.FirstRun, j.Interval, func() { j.RunOnce(ctx) })
}

// RunOnce sweeps now and reports how many homes it removed. When the records cannot be read nothing is removed: a home is only unreachable when the records say so.
func (j *HermesHomeSweep) RunOnce(ctx context.Context) int {
	live, err := j.liveIDs(ctx)
	if err != nil {
		j.logger.Warn("hermes: homes not swept, the sessions could not be read", "error", err)
		return 0
	}
	return agent.SweepHermesHomes(j.dataDir, func(id string) bool { return live[id] }, j.MinAge, j.now())
}
