package background

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/proxy"
	"github.com/subgentic/coral/internal/store"
)

// The Cost on the Analytics page is what the token poller stored per turn. This reads a transcript of several models back out of the database and prices every row again from its own
// tokens and the price table: cost = tokens x the model's prices, row by row, so a total that adds up (the consistency tests) is also right, not just consistent.
func TestStoredCostIsTokensTimesThePricesOfItsModel(t *testing.T) {
	db := setupTestDB(t)
	ss := store.NewSessionStore(db)
	us := store.NewTokenUsageStore(db)
	ctx := context.Background()
	const sid = "00000000-0000-0000-0000-0000000000c1"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "pricing", WorkingDir: t.TempDir()}))

	type turn struct {
		model                        string
		in, out, cacheWrite, cacheRd int
	}
	turns := []turn{
		{"claude-opus-5-5", 1200, 340, 800, 15000},
		{"claude-sonnet-5-5", 90, 2100, 0, 40000},
		{"claude-haiku-5-5", 5000, 50, 120, 0},
		{"claude-fable-5-1", 32, 100, 650, 292368},
		{"claude-opus-5-5", 7, 1, 0, 0},
	}
	var b strings.Builder
	for i, tn := range turns {
		fmt.Fprintf(&b, `{"type":"assistant","message":{"model":%q,"usage":{"input_tokens":%d,"output_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d}},"timestamp":"2026-09-16T07:%02d:00Z"}`+"\n", tn.model, tn.in, tn.out, tn.cacheWrite, tn.cacheRd, 10+i)
	}
	poller := NewTokenPoller(ss, us, time.Hour)
	poller.sessionPaths[sid] = writeTestJSONL(t, b.String())
	ls, err := ss.GetLiveSession(ctx, sid)
	require.NoError(t, err)
	poller.pollClaudeSession(ctx, ls)

	stored, err := us.GetSessionTurns(ctx, sid)
	require.NoError(t, err)
	require.NotEmpty(t, stored)
	var in, out, cw, cr int64
	var cost float64
	for _, r := range stored {
		want := proxy.CalculateCost(r.Model, proxy.TokenUsage{InputTokens: int(r.InputTokens), OutputTokens: int(r.OutputTokens), CacheReadTokens: int(r.CacheReadTokens), CacheWriteTokens: int(r.CacheWriteTokens)})
		assert.Greater(t, want, 0.0, "%s is a priced model: a row of it is not free", r.Model)
		assert.InDelta(t, want, r.CostUSD, 1e-9, "%s %v: the stored cost is its tokens times the price table", r.Model, r.RecordedAt)
		in, out, cw, cr, cost = in+r.InputTokens, out+r.OutputTokens, cw+r.CacheWriteTokens, cr+r.CacheReadTokens, cost+r.CostUSD
	}
	var wantIn, wantOut, wantCW, wantCR int64
	var wantCost float64
	for _, tn := range turns {
		wantIn, wantOut, wantCW, wantCR = wantIn+int64(tn.in), wantOut+int64(tn.out), wantCW+int64(tn.cacheWrite), wantCR+int64(tn.cacheRd)
		wantCost += proxy.CalculateCost(tn.model, proxy.TokenUsage{InputTokens: tn.in, OutputTokens: tn.out, CacheReadTokens: tn.cacheRd, CacheWriteTokens: tn.cacheWrite})
	}
	assert.Equal(t, []int64{wantIn, wantOut, wantCW, wantCR}, []int64{in, out, cw, cr}, "no turn of the transcript is lost or counted twice")
	assert.InDelta(t, wantCost, cost, 1e-9)
}
