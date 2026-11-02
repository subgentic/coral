package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #12026: the Operator opening a file's comments is what clears "new comments" on its row: the owner's read of the thread list marks the threads they started on that file seen. An agent reading the thread, and
// a Coral Hub viewer, do not.
func TestOnlyTheOwnersReadOfTheCommentsClearsNewComments(t *testing.T) {
	rig := newCmtRig(t)
	ctx := context.Background()
	root := rig.ownerComment("please check the lock")
	_, err := rig.ss.CreateArtifactComment(ctx, store.ArtifactComment{ArtifactID: cmtDoc, Board: "team-a", ParentID: &root, Body: "checked, it holds",
		AuthorIssuer: "agent", AuthorSubject: "s1", AuthorName: "Dev", AuthorKind: "agent"})
	require.NoError(t, err)
	unseen := func() int {
		got, err := rig.ss.UnseenAgentReplies(ctx)
		require.NoError(t, err)
		return len(got)
	}
	require.Equal(t, 1, unseen(), "the agent replied in the Operator's thread")

	_, err = rig.h.bs.Subscribe(ctx, "team-a", "dev", "Developer", "agent-s1", nil, "")
	require.NoError(t, err)
	rig.uploadedBySession("s1", "team-a")
	code, _ := rig.do("GET", cp(cmtDoc), cmtAsAgent, nil)
	require.Equal(t, 200, code)
	assert.Equal(t, 1, unseen(), "an agent reading its own reply is not the Operator opening the thread")

	code, _ = rig.do("GET", cp(cmtDoc), cmtAsOwner, nil)
	require.Equal(t, 200, code)
	assert.Zero(t, unseen(), "the owner opened the thread")
}
