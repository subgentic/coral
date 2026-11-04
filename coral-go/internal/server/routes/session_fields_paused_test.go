package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gitguard"
	"github.com/subgentic/coral/internal/store"
)

// A row of a folder whose live git updates are paused carries git_state.paused with the last known count (#13092), so the sidebar and the header say so; a folder that is not paused is as it was.
func TestGitListFieldsMarksAFolderWithPausedLiveUpdates(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	plain := &store.GitSnapshot{Branch: "main", WorkingDirectory: "/work/repo", DirtyCount: 3}
	_, _, state := gitListFields(plain)
	require.Nil(t, state, "a branch with no base and no pause has no git_state, as before")

	gitguard.Pause("/work/repo", 35000, 3200*time.Millisecond)
	_, _, state = gitListFields(plain)
	gs, ok := state.(map[string]any)
	require.True(t, ok, "a paused folder has a git_state")
	paused, ok := gs["paused"].(map[string]any)
	require.True(t, ok, "with the pause in it")
	require.Equal(t, 35000, paused["changes"], "the last known count")
	require.EqualValues(t, 3200, paused["took_ms"])
	require.Equal(t, 3, gs["dirty"])

	other := &store.GitSnapshot{Branch: "main", WorkingDirectory: "/work/other", Worktree: true}
	_, _, state = gitListFields(other)
	_, has := state.(map[string]any)["paused"]
	require.False(t, has, "another folder is not marked")
}
