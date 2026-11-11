package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15506: Codex's input_tokens already include its cached part (OpenAI's own count, and the cost code relies on it), so the context a Codex call carried is its input, not input plus cache read.
// The sum Claude's rows need (its input is only the uncached part) counted Codex's cached tokens twice: a 68k context showed as 136k on the card and past the compaction threshold at half its real size.
func TestTheContextOfACodexCallIsItsInputAndNotInputPlusCacheRead(t *testing.T) {
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	require.NoError(t, s.RecordUsage(ctx, &TokenUsage{
		SessionID: "cx-1", AgentName: "Cx", AgentType: "codex", Model: "gpt-6.1-sol",
		InputTokens: 68390, CacheReadTokens: 68096, OutputTokens: 30, TotalTokens: 68420, RecordedAt: "2026-11-10T07:00:00.000Z", Source: "jsonl",
	}))
	require.NoError(t, s.RecordUsage(ctx, &TokenUsage{
		SessionID: "cl-1", AgentName: "Cl", AgentType: "claude", Model: "claude-opus-5-5",
		InputTokens: 3, CacheReadTokens: 68096, CacheWriteTokens: 294, OutputTokens: 30, TotalTokens: 68423, RecordedAt: "2026-11-10T07:00:00.000Z", Source: "jsonl",
	}))
	got, err := s.GetLatestTurnContextBySessionIDs(ctx, []string{"cx-1", "cl-1"})
	require.NoError(t, err)
	assert.Equal(t, 68390, got["cx-1"], "a Codex call's context is its input: the cached tokens are inside it")
	assert.Equal(t, 68393, got["cl-1"], "Claude's rows still add the cache, as before (its input is only the uncached part)")
}
