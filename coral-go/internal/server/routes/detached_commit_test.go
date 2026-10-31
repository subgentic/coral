package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/store"
)

// #11580: a detached checkout's branch is the word HEAD, shared by every detached agent: its row also names the short commit, so two agents on two worktrees read differently. A checkout on a branch, or with no commit, has none.
func TestDetachedCommitNamesTheShortCommitOnlyForAHeadlessCheckout(t *testing.T) {
	assert.Equal(t, "abc1234", detachedCommit(&store.GitSnapshot{Branch: "HEAD", CommitHash: "abc1234def5678abc1234def5678abc1234def56"}))
	assert.Nil(t, detachedCommit(&store.GitSnapshot{Branch: "feature/x", CommitHash: "abc1234def5678abc1234def5678abc1234def56"}), "on a branch: nothing to add")
	assert.Nil(t, detachedCommit(&store.GitSnapshot{Branch: "HEAD", CommitHash: "abc"}), "no usable commit: nothing")
	assert.Nil(t, detachedCommit(nil))
}
