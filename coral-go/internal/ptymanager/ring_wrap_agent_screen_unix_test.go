//go:build !windows

package ptymanager

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// The input gate reads PTYSessionTerminal.AgentScreen, and the dashboard's styled check AgentScreenStyled: after the replay ring wrapped, both must show the composer drawn once (#6481).
func TestAgentScreenKeepsTheInputBoxAfterTheReplayRingWrapped(t *testing.T) {
	canFork(t)
	backend := NewPTYBackend()
	defer backend.Close()
	const sid = "6481aaaa-0000-4000-8000-000000000001"
	name := naming.SessionName("codex", sid)
	require.NoError(t, backend.Spawn(name, "codex", t.TempDir(), sid, codexLikeStandIn, 120, 40))
	// The wait is for the stand-in's last line, read from the ring itself: a subscriber is cut off for falling behind (lag.go) when this goroutine is not scheduled for a moment under load, and the test
	// saw "the terminal closed" (#7746, as ring_wrap_screen_unix_test.go).
	require.Eventually(t, func() bool {
		replay, err := backend.Replay(name)
		return err == nil && strings.Contains(string(replay), "REPAINTS-DONE")
	}, 2*time.Minute, 20*time.Millisecond, "the stand-in did not finish") // only the ceiling of a stand-in that never ends (#7163)
	replay, err := backend.Replay(name)
	require.NoError(t, err)
	require.NotContains(t, string(replay), "Ask Codex to do anything")

	term := NewPTYSessionTerminal(backend)
	screen, err := term.AgentScreen(context.Background(), name, "codex", sid)
	require.NoError(t, err)
	assert.True(t, InputBoxOnScreen(screen), "AgentScreen:\n%s", screen)
	rendered, err := term.RenderedScreen(context.Background(), name, "codex", sid)
	require.NoError(t, err)
	assert.Contains(t, rendered, "Ask Codex to do anything")
	styled, err := term.AgentScreenStyled(context.Background(), name, "codex", sid)
	require.NoError(t, err)
	assert.Contains(t, styled, "Ask Codex to do anything", "AgentScreenStyled")
	text, err := backend.RenderedScreenStyledText(name)
	require.NoError(t, err)
	assert.Contains(t, text, "Ask Codex to do anything", "RenderedScreenStyledText")
}
