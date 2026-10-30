package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #11351: a session registered within the clock's own tick, or stored a little ahead of this clock, is the youngest session there is, not an unknown one: its row says starting (and, once it has been
// silent for 25 s, not_started), the same in two lists a moment apart. Windows' clock, which moves about once a millisecond, made TestWSLocalPartReuseEqualsAFullRebuild see starting:false then starting:true.
func TestAJustCreatedSessionIsInsideTheStartingWindow(t *testing.T) {
	ahead := time.Now().Add(200 * time.Millisecond).UTC().Format(store.ISOFormat)
	age := sessionAgeSeconds(ahead)
	assert.Greater(t, age, 0.0, "a stored time a little ahead of the clock is a session created now")
	assert.True(t, agentStarting(at.Claude, "", age, false, false, false), "and it is starting")
	assert.True(t, agentNeverStarted(at.Claude, "", notStartedThresholdSeconds, age), "and, silent for the threshold, never started")
	assert.Equal(t, 0.0, sessionAgeSeconds(time.Now().Add(time.Hour).UTC().Format(store.ISOFormat)), "a time an hour ahead is skew, unknown")
	assert.Equal(t, 0.0, sessionAgeSeconds(""), "a missing time is unknown")
	assert.Equal(t, 0.0, sessionAgeSeconds("not a time"), "so is one that does not parse")
}
