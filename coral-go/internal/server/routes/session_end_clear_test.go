package routes

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
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

// After a /clear the hook tells the CLI's new session id on the session_reset event (#14849) and Coral reads that transcript from then on; an id that is another agent's session, one that is not a session
// id, or the agent's own changes nothing.
func TestAClearsNewSessionIDIsFollowedAndNoOtherIs(t *testing.T) {
	r := newHoldRig(t, true)
	t.Cleanup(func() { jsonl.SetTranscriptAlias(r.sid, "", time.Time{}) })
	const other, fresh = "cccccccc-6610-4000-8000-000000000002", "dddddddd-6610-4000-8000-000000000003"
	require.NoError(t, r.h.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: other, AgentType: "claude", AgentName: "other", WorkingDir: "/tmp/other"}))

	r.post(`{"event_type":"session_reset","summary":"Session reset: /clear","detail_json":{"claude_session_id":"` + other + `","source":"clear"}}`)
	assert.Empty(t, jsonl.TranscriptAlias(r.sid), "another agent's session is not this agent's transcript")
	// a session of Coral's that has ended (no live row, but it sent events) is refused too
	const ended = "eeeeeeee-6610-4000-8000-000000000004"
	_, err := r.h.ts.InsertAgentEvent(context.Background(), &store.AgentEvent{AgentName: "gone", SessionID: &[]string{ended}[0], EventType: "stop", Summary: "stopped"})
	require.NoError(t, err)
	r.post(`{"event_type":"session_reset","summary":"Session reset: /clear","detail_json":{"claude_session_id":"` + ended + `","source":"clear"}}`)
	assert.Empty(t, jsonl.TranscriptAlias(r.sid), "an ended session of Coral's is not this agent's transcript")
	r.post(`{"event_type":"session_reset","summary":"Session reset: /clear","detail_json":{"claude_session_id":"../../etc/passwd","source":"clear"}}`)
	assert.Empty(t, jsonl.TranscriptAlias(r.sid), "not a session id")
	r.post(`{"event_type":"session_reset","summary":"Session reset: /clear","detail_json":{"claude_session_id":"` + r.sid + `","source":"clear"}}`)
	assert.Empty(t, jsonl.TranscriptAlias(r.sid), "its own id is no alias")
	r.post(`{"event_type":"session_reset","summary":"Session reset: /clear","detail_json":{"claude_session_id":"` + fresh + `","source":"clear"}}`)
	assert.Equal(t, fresh, jsonl.TranscriptAlias(r.sid), "the new session of a cleared agent is its transcript")
}
