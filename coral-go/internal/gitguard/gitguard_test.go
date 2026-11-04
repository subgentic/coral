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

// QA's SHOULD 5 on #13079: one slow pass (a build running) does not pause a folder for good; two in a row do, a fast one between them starts the count again, and a paused folder is tried again after RetryAfter.
func TestObservePausesAfterTwoSlowPassesAndAFastPassResumes(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	slow, fast := 3*time.Second, 100*time.Millisecond
	require.False(t, Observe("/repo", 10, slow), "one slow pass is not enough")
	_, ok := Get("/repo")
	require.False(t, ok)
	require.False(t, Observe("/repo", 10, fast), "a fast pass between clears the count")
	require.False(t, Observe("/repo", 10, slow), "so the next slow pass is the first again")
	require.True(t, Observe("/repo", 35000, slow), "the second in a row pauses")
	p, ok := Get("/repo")
	require.True(t, ok)
	require.Equal(t, 35000, p.Changes)
	require.True(t, Observe("/repo", 35000, slow), "a slow pass of a paused folder keeps it paused")
	require.False(t, Observe("/repo", 12, fast), "a fast pass (the retry, or a manual Refresh) turns live updates back on")
	_, ok = Get("/repo")
	require.False(t, ok)
}

func TestRetryDueAfterTheWait(t *testing.T) {
	Reset()
	t.Cleanup(Reset)
	old := RetryAfter
	t.Cleanup(func() { RetryAfter = old })
	RetryAfter = 10 * time.Minute
	require.False(t, RetryDue("/repo", time.Now()), "a folder that is not paused has no retry")
	Pause("/repo", 5, time.Second)
	require.False(t, RetryDue("/repo", time.Now().Add(9*time.Minute)), "not before the wait")
	require.True(t, RetryDue("/repo", time.Now().Add(11*time.Minute)), "after it")
}
