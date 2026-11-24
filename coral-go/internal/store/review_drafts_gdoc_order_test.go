package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func heldGdoc(ref, body string) ReviewDraft {
	return ReviewDraft{ArtifactID: artA, Owner: "local|me", Board: "b", AnchorJSON: `{"whole":true}`, Body: body, Source: ReviewDraftGdoc, SourceName: "Ann", SourceRef: ref}
}

var sendAuthor = ArtifactComment{AuthorIssuer: "local", AuthorSubject: "me", AuthorName: "me", AuthorKind: "owner"}

// #21196 QA MUST: the owner deletes a held Google root and keeps its reply. A send goes ahead without the reply (it stays held), and once the next pull holds the root again, with a higher id than
// its reply, the root is sent first and the reply goes in its thread.
func TestADeletedGoogleRootNeverBlocksASendAndComesBackBeforeItsReply(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	root, _, err := s.CreateReviewDraft(ctx, heldGdoc("doc|c1", "root"))
	require.NoError(t, err)
	_, _, err = s.CreateReviewDraft(ctx, heldGdoc("doc|c1/r1", "reply"))
	require.NoError(t, err)
	_, _, err = s.CreateReviewDraft(ctx, ReviewDraft{ArtifactID: artA, Owner: "local|me", Board: "b", AnchorJSON: `{"whole":true}`, Body: "mine", Source: ReviewDraftLocal})
	require.NoError(t, err)
	_, cur, err := s.ListReviewDrafts(ctx, artA, "local|me")
	require.NoError(t, err)
	_, rev, err := s.DeleteReviewDraft(ctx, artA, "local|me", root.ID, cur)
	require.NoError(t, err)

	// the owner's own draft is sent; the reply whose root is gone stays held
	out, err := s.PromoteReviewDrafts(ctx, artA, "local|me", "req-a", rev, nil, sendAuthor)
	require.NoError(t, err)
	require.Len(t, out, 1)
	assert.Equal(t, "mine", out[0].Comment.Body)
	held, rev, err := s.ListReviewDrafts(ctx, artA, "local|me")
	require.NoError(t, err)
	require.Len(t, held, 1)
	assert.Equal(t, "doc|c1/r1", held[0].SourceRef)

	// only the held reply: nothing to send, and nothing is recorded
	_, err = s.PromoteReviewDrafts(ctx, artA, "local|me", "req-b", rev, nil, sendAuthor)
	assert.ErrorIs(t, err, ErrNoDraft)

	// the next pull holds the root again, after its reply
	_, rev, err = s.CreateReviewDraft(ctx, heldGdoc("doc|c1", "root"))
	require.NoError(t, err)
	out, err = s.PromoteReviewDrafts(ctx, artA, "local|me", "req-b", rev, nil, sendAuthor)
	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, "root", out[0].Comment.Body)
	assert.Equal(t, "reply", out[1].Comment.Body)
	require.NotNil(t, out[1].Comment.ParentID)
	assert.Equal(t, out[0].Comment.ID, *out[1].Comment.ParentID)
	held, _, err = s.ListReviewDrafts(ctx, artA, "local|me")
	require.NoError(t, err)
	assert.Empty(t, held)
}
