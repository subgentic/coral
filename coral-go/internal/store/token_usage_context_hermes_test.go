package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15508: Hermes keeps running totals, not one record per call, so Coral records the growth between two reads as a row (num_turns = the calls it holds). The size of one request is that growth divided by its calls:
// a poll that saw three new calls carrying 3,600 tokens in all is 1,200 a call, not 3,600. A row of one call is exact. Claude's row is untouched.
func TestTheContextOfAHermesRowIsItsTokensPerCall(t *testing.T) {
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	require.NoError(t, s.RecordUsage(ctx, &TokenUsage{
		SessionID: "h-1", AgentName: "Hm", AgentType: "hermes", Model: "some-model", NumTurns: 3,
		InputTokens: 600, CacheReadTokens: 3000, OutputTokens: 40, TotalTokens: 640, RecordedAt: "2026-11-10T07:00:00.000Z", Source: "jsonl",
	}))
	require.NoError(t, s.RecordUsage(ctx, &TokenUsage{
		SessionID: "h-2", AgentName: "Hm2", AgentType: "hermes", Model: "some-model", NumTurns: 1,
		InputTokens: 700, CacheReadTokens: 4000, CacheWriteTokens: 100, OutputTokens: 40, TotalTokens: 740, RecordedAt: "2026-11-10T07:00:00.000Z", Source: "jsonl",
	}))
	require.NoError(t, s.RecordUsage(ctx, &TokenUsage{
		SessionID: "h-3", AgentName: "Hm3", AgentType: "hermes", Model: "some-model",
		InputTokens: 900, OutputTokens: 40, TotalTokens: 940, RecordedAt: "2026-11-10T07:00:00.000Z", Source: "jsonl",
	}))
	require.NoError(t, s.RecordUsage(ctx, &TokenUsage{
		SessionID: "cl-1", AgentName: "Cl", AgentType: "claude", Model: "claude-opus-5-5", NumTurns: 3,
		InputTokens: 3, CacheReadTokens: 68096, CacheWriteTokens: 294, OutputTokens: 30, TotalTokens: 68423, RecordedAt: "2026-11-10T07:00:00.000Z", Source: "jsonl",
	}))
	got, err := s.GetLatestTurnContextBySessionIDs(ctx, []string{"h-1", "h-2", "h-3", "cl-1"})
	require.NoError(t, err)
	assert.Equal(t, 1200, got["h-1"], "three calls carried 3,600 tokens: 1,200 each")
	assert.Equal(t, 4800, got["h-2"], "one call is exact")
	assert.Equal(t, 900, got["h-3"], "a row with no call count is one call")
	assert.Equal(t, 68393, got["cl-1"], "Claude's row is its own sum, whatever its num_turns")
}
