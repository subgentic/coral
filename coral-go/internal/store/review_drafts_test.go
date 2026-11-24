package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func draftOf(art, owner, body string) ReviewDraft {
	return ReviewDraft{ArtifactID: art, Owner: owner, AnchorJSON: `{"whole":true}`, Body: body}
}

// #21189: one reviewer never sees or changes another's draft, and a version's drafts are its own.
func TestReviewDraftsBelongToOneReviewerOnOneVersion(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	mine, _, err := s.CreateReviewDraft(ctx, draftOf(artA, "local|me", "mine"))
	require.NoError(t, err)
	_, _, err = s.CreateReviewDraft(ctx, draftOf(artA, "local|other", "theirs"))
	require.NoError(t, err)
	_, _, err = s.CreateReviewDraft(ctx, draftOf(artB, "local|me", "other version"))
	require.NoError(t, err)

	got, rev, err := s.ListReviewDrafts(ctx, artA, "local|me")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "mine", got[0].Body)
	assert.EqualValues(t, 1, rev, "the revision is per reviewer and version")

	// Another reviewer cannot edit or delete it, even with the right revision.
	_, _, err = s.UpdateReviewDraft(ctx, artA, "local|other", mine.ID, "hijack", "", 1)
	assert.ErrorIs(t, err, ErrNoDraft)
	_, _, err = s.DeleteReviewDraft(ctx, artA, "local|other", mine.ID, 1)
	assert.ErrorIs(t, err, ErrNoDraft)
	// Nor through another version's key.
	_, _, err = s.UpdateReviewDraft(ctx, artB, "local|me", mine.ID, "wrong version", "", 1)
	assert.ErrorIs(t, err, ErrNoDraft)

	counts, err := s.ReviewDraftCounts(ctx, "local|me")
	require.NoError(t, err)
	assert.Equal(t, map[string]int{artA: 1, artB: 1}, counts)
}

func TestReviewDraftsLimitAndStaleWritesChangeNothing(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	var first ReviewDraft
	for i := 0; i < MaxReviewDrafts; i++ {
		d, _, err := s.CreateReviewDraft(ctx, draftOf(artA, "local|me", "d"))
		require.NoError(t, err)
		if i == 0 {
			first = d
		}
	}
	_, _, err := s.CreateReviewDraft(ctx, draftOf(artA, "local|me", "one too many"))
	assert.ErrorIs(t, err, ErrDraftLimit)
	_, _, err = s.CreateReviewDraft(ctx, draftOf(artA, "local|you", "another reviewer is not limited by mine"))
	assert.NoError(t, err)

	_, cur, err := s.UpdateReviewDraft(ctx, artA, "local|me", first.ID, "stale", "", 3)
	assert.ErrorIs(t, err, ErrStaleRevision)
	assert.EqualValues(t, MaxReviewDrafts, cur)
	got, _, _ := s.ListReviewDrafts(ctx, artA, "local|me")
	assert.Equal(t, "d", got[0].Body, "a stale write changed nothing")
}

func TestDeletingAnArtifactDropsItsDrafts(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	_, _, err := s.CreateReviewDraft(ctx, draftOf(artA, "local|me", "x"))
	require.NoError(t, err)
	_, err = s.DeleteArtifactComments(ctx, artA)
	require.NoError(t, err)
	got, rev, err := s.ListReviewDrafts(ctx, artA, "local|me")
	require.NoError(t, err)
	assert.Empty(t, got)
	assert.EqualValues(t, 0, rev)
}
