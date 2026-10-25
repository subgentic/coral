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
	FirstRun, Interval time.Duration
}

// NewGoalEventsPrune returns the job for the board store.
func NewGoalEventsPrune(bs *board.Store) *GoalEventsPrune {
	return &GoalEventsPrune{bs: bs, logger: slog.Default(), Keep: GoalEventsKeep, FirstRun: 5 * time.Minute, Interval: time.Hour}
}

// Run prunes FirstRun after startup, then every Interval, until ctx is done.
func (j *GoalEventsPrune) Run(ctx context.Context) error {
	return runEvery(ctx, j.FirstRun, j.Interval, func() { j.RunOnce(ctx) })
}

// RunOnce deletes the events past the newest Keep of each board and reports how many.
func (j *GoalEventsPrune) RunOnce(ctx context.Context) int64 {
	n, err := j.bs.PruneGoalEvents(ctx, j.Keep)
	if err != nil {
		j.logger.Warn("goal events: could not prune", "error", err)
		return 0
	}
	if n > 0 {
		j.logger.Info("goal events: pruned", "rows", n)
	}
	return n
}
