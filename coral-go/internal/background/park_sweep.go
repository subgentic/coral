package background

import (
	"context"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// ParkSweep settles the timed parks that have ended (#11659): a park's end passes with nothing running, so its task takes the owner's slot back, and an owner who claimed another task meanwhile would
// hold two in progress. Claims and the task lists settle it where they read; the sweep covers the reads that do not (the cross-board query, the board's status).
type ParkSweep struct {
	bs       *board.Store
	logger   *slog.Logger
	Interval time.Duration
}

// NewParkSweep returns the job for the board store.
func NewParkSweep(bs *board.Store) *ParkSweep {
	return &ParkSweep{bs: bs, logger: slog.Default(), Interval: time.Minute}
}

// Run sweeps every Interval until ctx is done.
func (j *ParkSweep) Run(ctx context.Context) error {
	return runOnTicker(ctx, j.Interval, func() { j.RunOnce(ctx) })
}

// RunOnce releases the lapsed parks of every board and reports how many tasks went back to pending.
func (j *ParkSweep) RunOnce(ctx context.Context) int {
	n, err := j.bs.ReleaseLapsedParks(ctx, "")
	if err != nil {
		j.logger.Warn("parks: could not settle the lapsed ones", "error", err)
		return 0
	}
	if n > 0 {
		j.logger.Info("parks: lapsed parks queued behind the task in hand", "tasks", n)
	}
	return n
}
