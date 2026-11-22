package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
)

// #20692: a screen read leaves what the live row needs: that the agent is stopped by a usage limit, and when it resets (zero when its screen names no time).
func TestScreenLimitNotesTheVendorsLimitAndItsResetForTheLiveRow(t *testing.T) {
	ctx := context.Background()
	read := func(sid, typ, screen string) (time.Time, bool) {
		t.Helper()
		t.Cleanup(func() { ptymanager.NoteUsageLimit(sid, false, time.Time{}, time.Time{}) })
		f := screenLimit(screenRT{screen: screen})
		require.NotNil(t, f)
		f(ctx, AgentInfo{AgentType: typ, SessionID: sid})
		return ptymanager.UsageLimitOf(sid, time.Minute, time.Now())
	}

	// agy: "Resets in 103h13m54s" is a time
	at, ok := read("ul-agy", "agy", "⚠ Individual quota reached. Please upgrade. Resets in\n103h13m54s.\nError ID: x\n\n [1] Good  [2] Fine  [3] Bad  [0] Skip\n")
	require.True(t, ok)
	assert.WithinDuration(t, time.Now().Add(103*time.Hour+13*time.Minute+54*time.Second), at, 5*time.Second)

	// Codex: a dated notice, a relative one, and one with no time at all
	at, ok = read("ul-codex-abs", "codex", "■ You've hit your usage limit. Upgrade to Pro or try again at Nov 1st, 2030 10:07 PM.\n\n› \n")
	require.True(t, ok)
	assert.WithinDuration(t, time.Date(2030, 11, 1, 22, 7, 0, 0, time.Local), at, 2*time.Second) // now + (the time left, read a moment earlier)
	at, ok = read("ul-codex-rel", "codex", "■ You've hit your usage limit. Try again in 3 days 2 hours 5 minutes.\n\n› \n")
	require.True(t, ok)
	assert.WithinDuration(t, time.Now().Add(74*time.Hour+5*time.Minute), at, 5*time.Second)
	at, ok = read("ul-codex-none", "codex", "■ You've hit your usage limit.\n\n› \n")
	require.True(t, ok, "stopped by a limit")
	assert.True(t, at.IsZero(), "with no reset time: unknown, never a guess")

	// not a limit: an idle screen, and a refused model (which blocks, but is not a usage limit)
	_, ok = read("ul-idle", "codex", "› Ask Codex to do anything\n")
	assert.False(t, ok)
	_, ok = read("ul-refused", "codex", "■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\n\n› \n")
	assert.False(t, ok, "a refused model is its own block")

	// a limit that is then gone from the screen is forgotten
	t.Cleanup(func() { ptymanager.NoteUsageLimit("ul-gone", false, time.Time{}, time.Time{}) })
	limitedScreen, idleScreen := "■ You've hit your usage limit. Try again in 3 hours.\n\n› \n", "› Ask Codex to do anything\n"
	old := limitScreenTTL
	limitScreenTTL = 0
	defer func() { limitScreenTTL = old }()
	screenLimit(screenRT{screen: limitedScreen})(ctx, AgentInfo{AgentType: "codex", SessionID: "ul-gone"})
	_, ok = ptymanager.UsageLimitOf("ul-gone", time.Minute, time.Now())
	require.True(t, ok)
	screenLimit(screenRT{screen: idleScreen})(ctx, AgentInfo{AgentType: "codex", SessionID: "ul-gone"})
	_, ok = ptymanager.UsageLimitOf("ul-gone", time.Minute, time.Now())
	assert.False(t, ok)
}
