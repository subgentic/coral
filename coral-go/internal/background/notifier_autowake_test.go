package background

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// One board's messages wake at most ten agents in an hour (Security, #12111); the hour is a sliding one.
func TestAutoWakeBoardCap(t *testing.T) {
	n := &BoardNotifier{}
	t0 := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	for i := 0; i < autoWakeBoardCap; i++ {
		assert.True(t, n.takeAutoWakeSlot("team", t0.Add(time.Duration(i)*time.Minute)), "wake %d", i+1)
	}
	assert.False(t, n.takeAutoWakeSlot("team", t0.Add(20*time.Minute)), "the eleventh in the hour is held")
	assert.True(t, n.takeAutoWakeSlot("other", t0.Add(20*time.Minute)), "another board has its own count")
	assert.True(t, n.takeAutoWakeSlot("team", t0.Add(61*time.Minute)), "the first wake is an hour old: one slot is free again")
}
