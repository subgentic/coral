package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// A window that ends before the newest rows (a past window, a clock behind, a row stamped late): the window's total stops at its end, and so does each agent's (#8235: the agents were summed
// from the start with no end, so their rows did not add up to the total beside them).
func TestSpendAgentTokensStopAtTheWindowEndLikeTheTotal(t *testing.T) {
	rig := newSpendRig(t) // the clock is 2026-10-25T10:30Z: the 24 h window ends 2026-10-25T11:00Z
	bn := rig.board
	for _, at := range []string{"2026-10-25T11:30:00Z", "2026-10-25T14:10:00Z", "2026-10-26T01:00:00Z"} {
		require.NoError(t, store.NewTokenUsageStore(rig.h.db).RecordUsage(context.Background(), &store.TokenUsage{SessionID: "aaaaaaaa-7525-4000-8000-000000000001", AgentName: "Backend Dev", AgentType: "claude", BoardName: &bn,
			InputTokens: 5000, OutputTokens: 5000, TotalTokens: 10000, RecordedAt: at, Source: "jsonl"}))
	}
	code, out := rig.get(t, "/api/board/"+rig.board+"/spend?range=24h")
	require.Equal(t, http.StatusOK, code, "%v", out)
	win := out["tokens"].(map[string]any)["window"].(map[string]any)
	total := num(win["input"]) + num(win["output"])
	assert.EqualValues(t, 1000+300+700+500+100+300, total, "the total stops at the window's end")
	var sum float64
	for _, a := range out["agents"].([]any) {
		if tok, ok := a.(map[string]any)["tokens"].(float64); ok {
			sum += tok
		}
	}
	assert.EqualValues(t, total, sum, "the agents' tokens add up to the window's total")
}
