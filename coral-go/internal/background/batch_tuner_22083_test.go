package background

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #22083: a slow disk shrinks the batch and lengthens the pause, so no delete holds the writer long.

func TestTheBatchStartsSmallGrowsWhileQuickAndShrinksWhenSlow(t *testing.T) {
	tune := newBatchTuner(2000, 5*time.Millisecond)
	assert.Equal(t, batchStart, tune.Size(), "the first batch is small")
	for i := 0; i < 10; i++ {
		tune.Took(time.Millisecond)
	}
	assert.Equal(t, 2000, tune.Size(), "quick batches grow to the job's size and no further")
	tune.Took(2 * time.Second)
	assert.Equal(t, 1000, tune.Size(), "a slow batch halves the next")
	for i := 0; i < 20; i++ {
		tune.Took(2 * time.Second)
	}
	assert.Equal(t, batchFloor, tune.Size(), "the batch never goes under its floor")
}

func TestThePauseIsAtLeastAsLongAsTheBatchTook(t *testing.T) {
	tune := newBatchTuner(2000, 5*time.Millisecond)
	assert.Equal(t, 5*time.Millisecond, tune.Took(time.Millisecond), "a quick batch pauses its Pause")
	assert.Equal(t, 800*time.Millisecond, tune.Took(800*time.Millisecond), "a slow batch pauses as long as it took, so the writer is free half the time")
	assert.Equal(t, 1, newBatchTuner(0, 0).Size(), "a job with no size still deletes")
	assert.Equal(t, 3, newBatchTuner(3, 0).Size(), "the start is never over the job's size")
}
