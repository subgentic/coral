package store

import (
	"context"
	"github.com/stretchr/testify/require"
	"math"
	"testing"
)

func TestVideoTimesStoreRoundTripAndValidation(t *testing.T) {
	s := newCommentStore(t)
	ctx := context.Background()
	at, end := 0.0, 12.25
	c := mk(artA, "team-a", "cut", nil)
	c.AtS, c.EndS = &at, &end
	made, err := s.CreateArtifactComment(ctx, c)
	require.NoError(t, err)
	got, ok, err := s.GetArtifactComment(ctx, artA, made.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, &at, got.AtS)
	require.Equal(t, &end, got.EndS)
	for _, v := range []float64{-1, 604801, math.NaN(), math.Inf(1), math.Inf(-1)} {
		c.AtS, c.EndS = &v, nil
		_, err = s.CreateArtifactComment(ctx, c)
		require.ErrorIs(t, err, ErrBadCommentTime)
	}
	c.AtS, c.EndS = nil, &end
	_, err = s.CreateArtifactComment(ctx, c)
	require.ErrorIs(t, err, ErrBadCommentTime)
	c.AtS, c.EndS = &at, &at
	_, err = s.CreateArtifactComment(ctx, c)
	require.ErrorIs(t, err, ErrBadCommentTime)
	c.AtS, c.EndS = &at, &end
	c.ParentID = &made.ID
	_, err = s.CreateArtifactComment(ctx, c)
	require.ErrorIs(t, err, ErrBadCommentTime)
}

func TestVideoTimelineOrderKeepsRepliesAndFiltersBoards(t *testing.T) {
	s := newCommentStore(t)
	ctx := context.Background()
	makeAt := func(at float64, board string) ArtifactComment {
		c := mk(artA, board, "cut", nil)
		c.AtS = &at
		v, e := s.CreateArtifactComment(ctx, c)
		require.NoError(t, e)
		return v
	}
	late := makeAt(30, "team-a")
	early := makeAt(0, "team-a")
	makeAt(1, "team-b")
	reply, e := s.CreateArtifactComment(ctx, mk(artA, "team-a", "reply", &early.ID))
	require.NoError(t, e)
	list, e := s.ListArtifactComments(ctx, artA, "open", []string{"team-a"})
	require.NoError(t, e)
	require.Equal(t, []int64{early.ID, reply.ID, late.ID}, []int64{list[0].ID, list[1].ID, list[2].ID})
	_, _, e = s.SetArtifactCommentResolved(ctx, artA, early.ID, true, "local", "owner")
	require.NoError(t, e)
	list, e = s.ListArtifactComments(ctx, artA, "open", []string{"team-a"})
	require.NoError(t, e)
	require.Len(t, list, 1)
	require.Equal(t, late.ID, list[0].ID)
}

func TestVideoEqualTimesUseRootIDTieBreakWithReplies(t *testing.T) {
	s := newCommentStore(t)
	ctx := context.Background()
	at := 10.0
	c := mk(artA, "team-a", "first", nil)
	c.AtS = &at
	first, e := s.CreateArtifactComment(ctx, c)
	require.NoError(t, e)
	second, e := s.CreateArtifactComment(ctx, c)
	require.NoError(t, e)
	reply, e := s.CreateArtifactComment(ctx, mk(artA, "team-a", "reply to first", &first.ID))
	require.NoError(t, e)
	list, e := s.ListArtifactComments(ctx, artA, "", nil)
	require.NoError(t, e)
	require.Equal(t, []int64{first.ID, reply.ID, second.ID}, []int64{list[0].ID, list[1].ID, list[2].ID})
}
