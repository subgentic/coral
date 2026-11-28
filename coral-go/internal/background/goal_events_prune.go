package background

import (
	"context"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// GoalEventsKeep is how many goal events of each board are kept (#7355): the feed's window is the newest 51, so a thousand is room for a connection that fell far behind to be told it missed some, not to catch up.
const GoalEventsKeep = 1000

// GoalEventsPrune keeps the newest GoalEventsKeep goal events of each board and deletes the older ones: five minutes after startup, then hourly. The triggers write the events (board.ensureGoalsSchema); this
// is the only thing that removes them.
type GoalEventsPrune struct {
	bs     *board.Store
	logger *slog.Logger

	Keep               int
	BatchSize          int           // rows one delete takes at most
	Pause              time.Duration // between batches: the board database is free for requests
	FirstRun, Interval time.Duration
}

// NewGoalEventsPrune returns the job for the board store.
func NewGoalEventsPrune(bs *board.Store) *GoalEventsPrune {
	return &GoalEventsPrune{bs: bs, logger: slog.Default(), Keep: GoalEventsKeep, BatchSize: 2000, Pause: 50 * time.Millisecond, FirstRun: 5 * time.Minute, Interval: time.Hour}
}

// Run prunes FirstRun after startup, then every Interval, until ctx is done.
func (j *GoalEventsPrune) Run(ctx context.Context) error {
	return runEvery(ctx, j.FirstRun, j.Interval, func() { j.RunOnce(ctx) })
}

// RunOnce deletes the events past the newest Keep of each board, in short batches with Pause between them (#22013), and reports how many.
func (j *GoalEventsPrune) RunOnce(ctx context.Context) int64 {
	var total int64
	tune := newBatchTuner(j.BatchSize, j.Pause)
	for ctx.Err() == nil {
		batch := tune.Size()
		t0 := time.Now()
		n, err := j.bs.PruneGoalEventsBatch(ctx, j.Keep, batch)
		if err == nil && n > 0 {
			if cerr := j.bs.CheckpointPassive(ctx); cerr != nil && ctx.Err() == nil { // the batch's pages out of the WAL, timed with it (#22119)
				j.logger.Debug("goal events: checkpoint", "error", cerr)
			}
		}
		pause := tune.Took(time.Since(t0))
		if err != nil {
			if ctx.Err() == nil {
				j.logger.Warn("goal events: could not prune", "error", err)
			}
			break
		}
		total += n
		if n < int64(batch) {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(pause):
		}
	}
	if total > 0 {
		j.logger.Info("goal events: pruned", "rows", total)
	}
	return total
}
