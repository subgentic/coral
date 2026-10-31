package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #11352: a finished tool call says when it began, from its stored duration, so a permission request opened before that is known to be past.
func TestStateEventOfAToolUseCarriesWhenItsCallBegan(t *testing.T) {
	ms := int64(157409)
	at := time.Date(2026, 10, 30, 17, 33, 41, 466000000, time.UTC)
	tool := "Bash"
	ev := AgentEvent{EventType: "tool_use", ToolName: &tool, CreatedAt: at.Format(time.RFC3339Nano), DurationMs: &ms}.StateEvent()
	assert.Equal(t, at.Add(-157409*time.Millisecond), ev.Started)

	none := AgentEvent{EventType: "tool_use", ToolName: &tool, CreatedAt: at.Format(time.RFC3339Nano)}.StateEvent()
	assert.True(t, none.Started.IsZero(), "no duration, no start")

	req := AgentEvent{EventType: "permission_request", ToolName: &tool, CreatedAt: at.Format(time.RFC3339Nano), DurationMs: &ms}.StateEvent()
	assert.True(t, req.Started.IsZero(), "only a finished tool call has a start")
}
