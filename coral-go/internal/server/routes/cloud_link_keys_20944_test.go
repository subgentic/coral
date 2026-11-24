package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// Design item 7: wrong-code finishes are counted across the whole process; past the limit every finish waits, and the count forgets after its window.
func TestFailedFinishesAreCountedProcessWide(t *testing.T) {
	finishFailures.Lock()
	finishFailures.at = nil
	finishFailures.Unlock()
	now := time.Now()
	for i := 0; i < finishFailureLimit-1; i++ {
		noteFinishFailure(now)
	}
	assert.False(t, finishFailuresOver(now))
	noteFinishFailure(now)
	assert.True(t, finishFailuresOver(now))
	assert.False(t, finishFailuresOver(now.Add(finishFailureWindow+time.Second)), "it forgets after the window")
}
