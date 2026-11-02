package background

import (
	"context"
	"log/slog"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// ActivityTrim keeps the Activity record to a year or 50,000 rows (#12069): ten minutes after startup, then daily. It is the only thing that removes a row, by age or count and oldest first, and it logs how many
// went (a number, never content), so a gap in the record is explained.
type ActivityTrim struct {
	bs     *board.Store
	logger *slog.Logger
	now    func() time.Time

	FirstRun, Interval time.Duration
}

// NewActivityTrim returns the job for the board store.
func NewActivityTrim(bs *board.Store) *ActivityTrim {
	return &ActivityTrim{bs: bs, logger: slog.Default(), now: time.Now, FirstRun: 10 * time.Minute, Interval: 24 * time.Hour}
}

// Run trims FirstRun after startup, then every Interval, until ctx is done.
func (j *ActivityTrim) Run(ctx context.Context) error {
	return runEvery(ctx, j.FirstRun, j.Interval, func() { j.RunOnce(ctx) })
}

// RunOnce trims and reports how many rows went.
func (j *ActivityTrim) RunOnce(ctx context.Context) int {
	n, err := j.bs.TrimActivity(ctx, j.now())
	if err != nil {
		j.logger.Warn("activity record: could not trim", "error", err)
		return 0
	}
	if n > 0 {
		j.logger.Info("activity record: trimmed", "rows", n)
	}
	return n
}
