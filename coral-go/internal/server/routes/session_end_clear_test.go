package routes

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/ptymanager"
)

var (
	processEndProbeOnce sync.Once
	processEndProbeMu   sync.Mutex
	processEnded        []string
)

func probeProcessEnds() {
	processEndProbeOnce.Do(func() {
		ptymanager.OnProcessEnd(func(name string) {
			processEndProbeMu.Lock()
			processEnded = append(processEnded, name)
			processEndProbeMu.Unlock()
		})
	})
}

func processEndedOf(name string) int {
	processEndProbeMu.Lock()
	defer processEndProbeMu.Unlock()
	n := 0
	for _, e := range processEnded {
		if e == name {
			n++
		}
	}
	return n
}

// Found live (#14849): a /clear says SessionEnd (reason "clear") and the same CLI process runs the next session, but Coral forgot the recorded agent process, so every board notice after it was refused as
// "the agent's process is not recorded". A clear keeps the record; a session that really ends (any other reason) drops it.
func TestAClearKeepsTheRecordedAgentProcessAndAnEndDropsIt(t *testing.T) {
	probeProcessEnds()
	r := newHoldRig(t, true)
	r.post(`{"event_type":"session_end","summary":"Session ended: clear","detail_json":{"reason":"clear"}}`)
	assert.Equal(t, 0, processEndedOf(r.name), "a /clear leaves the process, so its record stays")
	r.post(`{"event_type":"session_end","summary":"Session ended: other","detail_json":{"reason":"other"}}`)
	assert.Equal(t, 1, processEndedOf(r.name), "any other end forgets it")
	r.post(`{"event_type":"session_end","summary":"Session ended"}`)
	assert.Equal(t, 2, processEndedOf(r.name), "an end that names no reason is an end")
}
