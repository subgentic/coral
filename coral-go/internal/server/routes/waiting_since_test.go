package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/sessionstate"
)

// waiting_since is when the request began, only while the agent waits and the start is known (#6981).
func TestWaitingSinceIsTheRequestsStartOnlyWhileWaiting(t *testing.T) {
	at := time.Date(2026, 10, 24, 7, 30, 0, 0, time.FixedZone("x", 3600))
	assert.Equal(t, "2026-10-24T06:30:00Z", waitingSince(sessionstate.State{NeedsInput: true, WaitingSince: at}), "UTC")
	assert.Nil(t, waitingSince(sessionstate.State{NeedsInput: false, WaitingSince: at}), "not waiting")
	assert.Nil(t, waitingSince(sessionstate.State{NeedsInput: true}), "start not known")
	assert.Nil(t, waitingSince(sessionstate.Derive(sessionstate.Input{NeedsLogin: true, Events: []sessionstate.Event{{Type: "stop", At: at}}})), "a sign-in wait is raised from the screen: there is no request of the agent's to date")
	assert.Nil(t, waitingSince(sessionstate.Derive(sessionstate.Input{StartupPrompt: "trust this folder?", Events: []sessionstate.Event{{Type: "stop", At: at}}})), "nor a launch prompt")
	assert.Nil(t, waitingSince(sessionstate.Derive(sessionstate.Input{Events: []sessionstate.Event{{Type: "stop", At: at}, {Type: "notification", Summary: sessionstate.HeldInputSummary, At: at.Add(time.Minute)}}})), "Coral's held notice alone is not the agent asking")
	assert.NotNil(t, waitingSince(sessionstate.State{NeedsInput: true, WaitingKind: "permission", WaitingSince: at}), "an agent's own request has it")
}

// Distinct questions can arrive inside one second. Their serialized start time
// also identifies the waiting episode to clients, so it must not lose precision.
func TestWaitingSinceSeparatesRequestsWithinOneSecond(t *testing.T) {
	at := time.Date(2026, 11, 16, 4, 0, 0, 123456789, time.UTC)
	first := sessionstate.Event{Type: "permission_request", Kind: "permission", ToolName: "Bash", At: at}
	events := []sessionstate.Event{first}
	one := waitingSince(sessionstate.Derive(sessionstate.Input{Events: events}))
	events = append(events,
		sessionstate.Event{Type: "prompt_submit", At: at.Add(time.Millisecond)},
		sessionstate.Event{Type: "permission_request", Kind: "permission", ToolName: "Bash", At: at.Add(2 * time.Millisecond)},
	)
	two := waitingSince(sessionstate.Derive(sessionstate.Input{Events: events}))
	assert.Equal(t, "2026-11-16T04:00:00.123456789Z", one)
	assert.Equal(t, "2026-11-16T04:00:00.125456789Z", two)
	assert.NotEqual(t, one, two, "a second request must not reuse the client's episode key")
	events = append(events, sessionstate.Event{Type: "notification", Kind: "permission", At: at.Add(3 * time.Millisecond)})
	assert.Equal(t, two, waitingSince(sessionstate.Derive(sessionstate.Input{Events: events})), "the same open request keeps its start")
}
