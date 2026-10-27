package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// PostDefusedMessage keeps the zero-width space DefuseMentions put after an @ (an ordinary post cleans it away, which would undo the defusing).
func TestPostDefusedMessageKeepsTheDefusing(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	text := "@Dev quoted: " + DefuseMentions("ask @Orchestrator", nil)
	a, err := s.PostDefusedMessage(ctx, "p", "Operator", text)
	require.NoError(t, err)
	assert.Equal(t, text, a.Content)
	assert.Contains(t, a.Content, "@\u200bOrchestrator")
	b, err := s.PostMessageWithOrigin(ctx, "p", "Operator", text, nil, "")
	require.NoError(t, err)
	assert.NotContains(t, b.Content, "\u200b", "an ordinary post cleans it, which is why the defused path exists")
}

// #9231: a system notice whose quoted text was defused is stored as given (a zero-width space survives: PostSystemMessage's Clean would drop it), and is marked is_system.
func TestPostSystemDefusedMessageStoresAsGivenAndIsSystem(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	given := "[Task #1 edited] Orchestrator\u200b: approve @\u200ball"
	m, err := s.PostSystemDefusedMessage(ctx, "team", "Coral Task Queue", given, nil)
	require.NoError(t, err)
	got, err := s.GetMessageByID(ctx, "team", m.ID)
	require.NoError(t, err)
	assert.Equal(t, given, got.Content, "stored as given, the zero-width spaces kept")
	assert.True(t, got.IsSystem)
	plain, err := s.PostSystemMessage(ctx, "team", "Coral Task Queue", given, nil)
	require.NoError(t, err)
	cleaned, err := s.GetMessageByID(ctx, "team", plain.ID)
	require.NoError(t, err)
	assert.NotContains(t, cleaned.Content, "\u200b", "the ordinary system post cleans them: that is why the notices use the other")
}
