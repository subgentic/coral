package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #136584: the Operator approves (or asks changes of) an artifact a team tagged "for review": the tags the lists filter on change in one transaction with the review row that holds the time.
func TestApproveReplacesForReviewAndRecordsTheTime(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	obj := "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"for review", "read", "final"}))
	at := time.Date(2026, 10, 30, 10, 42, 0, 0, time.UTC)

	ch, tags, err := s.DecideArtifactReview(ctx, "alpha", obj, ReviewApproved, at)
	require.NoError(t, err)
	assert.True(t, ch.Changed)
	assert.Equal(t, []string{"approved", "final"}, tags, "for review and read go, approved comes: the row leaves Needs you, other tags stay")
	rv, err := s.ArtifactReviews(ctx, "alpha")
	require.NoError(t, err)
	assert.Equal(t, ArtifactReview{State: ReviewApproved, At: "2026-10-30T10:42:00Z"}, rv[obj])

	ch, tags, err = s.DecideArtifactReview(ctx, "alpha", obj, ReviewApproved, at.Add(time.Hour))
	require.NoError(t, err)
	assert.False(t, ch.Changed, "a second approve does nothing")
	assert.Equal(t, []string{"approved", "final"}, tags)
	rv, _ = s.ArtifactReviews(ctx, "alpha")
	assert.Equal(t, "2026-10-30T10:42:00Z", rv[obj].At, "and keeps the first time")
}

func TestAnObjectNotWaitingForReviewIsRefused(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	obj := "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"final"}))
	_, _, err := s.DecideArtifactReview(ctx, "alpha", obj, ReviewApproved, time.Now())
	assert.ErrorIs(t, err, ErrNotForReview)
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"reviewed"}))
	_, _, err = s.DecideArtifactReview(ctx, "alpha", obj, ReviewApproved, time.Now())
	assert.ErrorIs(t, err, ErrNotForReview, "the old Mark reviewed is settled")
}

func TestChangesRequestedKeepsTheRowAndApproveLaterSettlesIt(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	obj := "c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"for review", "read"}))
	ch, tags, err := s.DecideArtifactReview(ctx, "alpha", obj, ReviewChangesRequested, time.Now())
	require.NoError(t, err)
	assert.True(t, ch.Changed)
	assert.Equal(t, []string{"changes requested", "for review"}, tags, "still in Needs you, as unread again")
	ch, _, err = s.DecideArtifactReview(ctx, "alpha", obj, ReviewChangesRequested, time.Now())
	require.NoError(t, err)
	assert.False(t, ch.Changed, "asking twice changes nothing")
	_, tags, err = s.DecideArtifactReview(ctx, "alpha", obj, ReviewApproved, time.Now())
	require.NoError(t, err)
	assert.Equal(t, []string{"approved"}, tags)
	_, _, err = s.DecideArtifactReview(ctx, "alpha", obj, ReviewChangesRequested, time.Now())
	assert.ErrorIs(t, err, ErrNotForReview, "approved is settled")
}

func TestUndoPutsTheTagsAndTheStateBack(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	obj := "d1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"for review", "read"}))
	ch, _, err := s.DecideArtifactReview(ctx, "alpha", obj, ReviewApproved, time.Now())
	require.NoError(t, err)
	require.NoError(t, s.UndoArtifactReview(ctx, ch))
	tags, err := s.ArtifactTags(ctx, "alpha")
	require.NoError(t, err)
	assert.Equal(t, []string{"for review", "read"}, tags[obj], "as it was: the button can be pressed again")
	rv, _ := s.ArtifactReviews(ctx, "alpha")
	assert.Empty(t, rv)
	_, _, err = s.DecideArtifactReview(ctx, "alpha", obj, ReviewApproved, time.Now())
	assert.NoError(t, err)
}

// #136588: a new version of the series for review closes the older one's review, so the new one is the one pending; an approved older version is left alone.
func TestANewVersionSupersedesTheOlderReview(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	v1 := "e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"
	v0 := "e2b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", v1, []string{"for review", "changes requested", "read"}))
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", v0, []string{"approved"}))
	ok, err := s.SupersedeArtifactReview(ctx, "alpha", v1, time.Now())
	require.NoError(t, err)
	assert.True(t, ok)
	tags, err := s.ArtifactTags(ctx, "alpha")
	require.NoError(t, err)
	assert.Equal(t, []string{"superseded"}, tags[v1], "no longer something to review")
	ok, err = s.SupersedeArtifactReview(ctx, "alpha", v0, time.Now())
	require.NoError(t, err)
	assert.False(t, ok, "an approved version is left alone")
	assert.Equal(t, []string{"approved"}, func() []string { t2, _ := s.ArtifactTags(ctx, "alpha"); return t2[v0] }())
}
