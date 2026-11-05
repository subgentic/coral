package resources

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #13718 and #13705: an agent that is idle only because its background job holds the slot is not stuck.
func TestIdleStandsOnlyWhenNothingRunsBelowTheAgentAndItIsKnown(t *testing.T) {
	at := time.Date(2026, 11, 5, 21, 0, 0, 0, time.UTC)
	k, s := GuardIdle(SignalIdle, at, true, 0)
	assert.Equal(t, SignalIdle, k, "nothing runs: idle")
	assert.Equal(t, at, s)
	k, s = GuardIdle(SignalIdle, at, true, 2)
	assert.Empty(t, k, "a background job runs: working, not stuck")
	assert.True(t, s.IsZero())
	k, _ = GuardIdle(SignalIdle, at, false, 0)
	assert.Empty(t, k, "the process tree is not known: left alone")
	k, _ = GuardIdle(SignalPrompt, at, false, 5)
	assert.Equal(t, SignalPrompt, k, "a prompt is a prompt whatever runs")
}
