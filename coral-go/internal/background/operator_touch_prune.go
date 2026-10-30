package background

import (
	"context"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// OperatorTouchPrune deletes the Operator's touches older than board.TouchRetention (90 days, #11225): ten minutes after startup, then daily. It is the only thing that removes them.
type OperatorTouchPrune struct {
	bs     *board.Store
	logger *slog.Logger
	now    func() time.Time

	FirstRun, Interval time.Duration
}

// NewOperatorTouchPrune returns the job for the board store.
func NewOperatorTouchPrune(bs *board.Store) *OperatorTouchPrune {
	return &OperatorTouchPrune{bs: bs, logger: slog.Default(), now: time.Now, FirstRun: 10 * time.Minute, Interval: 24 * time.Hour}
}

// Run prunes FirstRun after startup, then every Interval, until ctx is done.
func (j *OperatorTouchPrune) Run(ctx context.Context) error {
	return runEvery(ctx, j.FirstRun, j.Interval, func() { j.RunOnce(ctx) })
}

// RunOnce deletes the touches past the retention and reports how many.
func (j *OperatorTouchPrune) RunOnce(ctx context.Context) int64 {
	n, err := j.bs.PruneOperatorTouches(ctx, j.now())
	if err != nil {
		j.logger.Warn("operator touches: could not prune", "error", err)
		return 0
	}
	if n > 0 {
		j.logger.Info("operator touches: pruned", "rows", n)
	}
	return n
}
