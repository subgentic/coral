package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// After a /clear the hook tells the CLI's new session id (#14849): the newest such session_reset of each session is the transcript it is written to, and an ordinary reset or another event tells nothing.
func TestTranscriptAliasesAreTheNewestClearOfEachSession(t *testing.T) {
	ts := NewTaskStore(openTestDB(t))
	ctx := context.Background()
	a, b := "aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"
	add := func(sid, typ, detail string) {
		var d *string
		if detail != "" {
			d = &detail
		}
		_, err := ts.InsertAgentEvent(ctx, &AgentEvent{AgentName: "x", SessionID: &sid, EventType: typ, Summary: typ, DetailJSON: d})
		require.NoError(t, err)
	}
	add(a, "session_reset", "")
	add(a, "session_reset", `{"claude_session_id":"cccccccc-3333-4333-8333-333333333333","source":"clear"}`)
	add(a, "tool_use", `{"claude_session_id":"ignored-not-a-reset"}`)
	add(a, "session_reset", `{"claude_session_id":"dddddddd-4444-4444-8444-444444444444","source":"clear"}`)
	add(b, "session_reset", "")
	got, err := ts.TranscriptAliases(ctx)
	require.NoError(t, err)
	require.Len(t, got, 1, "b was never cleared")
	assert.Equal(t, "dddddddd-4444-4444-8444-444444444444", got[a].ID, "the newest clear of a")
	assert.False(t, got[a].At.IsZero(), "and when it was told")
	assert.True(t, ts.SessionSentEvents(ctx, a), "an id that sent events is a session of Coral's")
	assert.False(t, ts.SessionSentEvents(ctx, "cccccccc-3333-4333-8333-333333333333"), "the id a clear moved to is not")
}
