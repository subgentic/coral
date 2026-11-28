package background

import "time"

// A prune deletes in batches so the database's one writer is never held behind one long delete (#22013). On a slow disk (a Windows runner's fsync) a fixed batch of thousands of rows
// held a write for 33 s (#22083), so each batch is timed and the size follows: it starts small, doubles while a batch is quick and halves when one is slow, and the pause after a
// batch is at least as long as the batch took, so the writer is free for at least half of the time.
const (
	// batchHold is the longest one batch should hold the writer; a batch over it halves the next.
	batchHold = 150 * time.Millisecond
	// batchStart is the first batch's size (or the job's BatchSize if smaller): a slow disk sees a small delete first.
	batchStart = 100
	// batchFloor is the smallest batch.
	batchFloor = 10
)

// batchTuner sizes the next batch from how long the last one held the writer.
type batchTuner struct {
	size, max int
	pause     time.Duration
}

// newBatchTuner starts at batchStart (or max if smaller); max is the job's BatchSize and pause its Pause.
func newBatchTuner(max int, pause time.Duration) *batchTuner {
	if max < 1 {
		max = 1
	}
	return &batchTuner{size: min(batchStart, max), max: max, pause: pause}
}

// Size is the next batch's row limit.
func (t *batchTuner) Size() int { return t.size }

// Took records how long the last batch held the writer and answers how long to pause before the next: its Pause, or the time the batch took if that is longer.
func (t *batchTuner) Took(d time.Duration) time.Duration {
	switch {
	case d > batchHold:
		t.size = max(batchFloor, t.size/2)
	case d < batchHold/4:
		t.size = min(t.max, t.size*2)
	}
	return max(t.pause, d)
}
