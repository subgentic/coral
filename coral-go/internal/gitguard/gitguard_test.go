package gitguard

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPausesSurviveARestartAndResumeClearsThem(t *testing.T) {
	dir := t.TempDir()
	Init(dir)
	t.Cleanup(Reset)
	_, ok := Get("/repo")
	require.False(t, ok)
	Pause("/repo", 35000, 3200*time.Millisecond)
	p, ok := Get("/repo")
	require.True(t, ok)
	require.Equal(t, 35000, p.Changes)
	require.EqualValues(t, 3200, p.TookMs)
	Init(dir) // a restart reads the file again
	p, ok = Get("/repo")
	require.True(t, ok, "still paused after a restart")
	require.Equal(t, 35000, p.Changes)
	Resume("/repo")
	Init(dir)
	_, ok = Get("/repo")
	require.False(t, ok, "resumed, and the file says so")
}
