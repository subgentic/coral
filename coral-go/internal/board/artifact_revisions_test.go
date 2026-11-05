package board

import (
	"context"
	"errors"
	"github.com/jmoiron/sqlx"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestArtifactRevisionsTrackBoardMutations(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const obj = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	other := s.ArtifactsRevision("other")
	check := func(name string, mutate func()) {
		t.Helper()
		before := s.ArtifactsRevision("team")
		mutate()
		require.Greater(t, s.ArtifactsRevision("team"), before, name)
		require.Equal(t, other, s.ArtifactsRevision("other"), name)
	}
	check("task result", func() { completeWith(t, s, ctx, "Dev", "artifact revision", true) })
	check("question", func() {
		_, err := s.SetArtifactQuestion(ctx, "team", obj, "Review?", "Dev", time.Now())
		require.NoError(t, err)
	})
	check("kind", func() {
		_, err := s.SetArtifactKind(ctx, "team", obj, "release", "Dev", time.Now())
		require.NoError(t, err)
	})
	check("upload notification", func() { s.NoteArtifactsChanged("team") })
	check("tag add", func() { _, err := s.AddArtifactTags(ctx, "team", obj, []string{"for review"}); require.NoError(t, err) })
	check("tag remove", func() { require.NoError(t, s.SetArtifactTags(ctx, "team", obj, nil)) })
	require.NoError(t, s.SetArtifactTags(ctx, "team", obj, []string{"for review"}))
	check("save", func() { _, _, err := s.SaveArtifactReview(ctx, "team", obj, true); require.NoError(t, err) })
	check("unsave", func() { _, _, err := s.SaveArtifactReview(ctx, "team", obj, false); require.NoError(t, err) })
	check("ignore", func() { _, _, err := s.IgnoreArtifactReview(ctx, "team", obj, true); require.NoError(t, err) })
	check("unignore", func() { _, _, err := s.IgnoreArtifactReview(ctx, "team", obj, false); require.NoError(t, err) })
	var decision ReviewChange
	check("decision", func() {
		var err error
		decision, _, err = s.DecideArtifactReview(ctx, "team", obj, ReviewApproved, time.Now())
		require.NoError(t, err)
	})
	check("rollback decision", func() { require.NoError(t, s.UndoArtifactReview(ctx, decision)) })
	check("supersede", func() {
		changed, err := s.SupersedeArtifactReview(ctx, "team", obj, time.Now())
		require.NoError(t, err)
		require.True(t, changed)
	})
}

func TestArtifactRevisionEpochAndStableReads(t *testing.T) {
	a, b := testStore(t), testStore(t)
	first := a.ArtifactsRevision("team")
	require.Equal(t, first, a.ArtifactsRevision("team"))
	require.NotEqual(t, first, b.ArtifactsRevision("team"))
	require.Less(t, first, uint64(1<<53))
}

func TestArtifactRevisionFollowsBoardLabelAndRemoval(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b, err := s.CreateBoard(ctx, "Before", "Operator")
	require.NoError(t, err)
	before, all := s.ArtifactsRevision(b.ID), s.ArtifactsRevision("")
	require.NoError(t, s.RenameBoard(ctx, b.ID, "After"))
	require.Greater(t, s.ArtifactsRevision(b.ID), before)
	require.Greater(t, s.ArtifactsRevision(""), all)
	before, all = s.ArtifactsRevision(b.ID), s.ArtifactsRevision("")
	require.NoError(t, s.DeleteProject(ctx, b.ID))
	require.Greater(t, s.ArtifactsRevision(b.ID), before)
	require.Greater(t, s.ArtifactsRevision(""), all)
}

func TestArtifactRevisionFollowsPrivateMark(t *testing.T) {
	s := testStore(t)
	for _, private := range []bool{true, false} {
		before := s.ArtifactsRevision("team")
		require.NoError(t, s.SetArtifactPrivate(context.Background(), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", private, "Operator"))
		require.Greater(t, s.ArtifactsRevision("team"), before)
	}
}

// The rebased tag writer keeps its CAS/transactional record semantics: a failed
// commit cannot advertise a revision for data that never committed.
func TestArtifactTagRevisionFollowsSuccessfulCommitOnly(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const team, hex = "team", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	require.NoError(t, s.SetArtifactTags(ctx, team, hex, []string{"for review"}))
	before := s.ArtifactsRevision(team)
	original := commitArtifactTagsTx
	t.Cleanup(func() { commitArtifactTagsTx = original })
	refused := errors.New("test commit refused")
	commitArtifactTagsTx = func(tx *sqlx.Tx) error { _ = tx.Rollback(); return refused }
	err := s.SetArtifactTagsIf(ctx, team, hex, []string{"for review"}, []string{"read"})
	require.ErrorIs(t, err, refused)
	require.Equal(t, before, s.ArtifactsRevision(team), "rolled-back tags have no new revision")
	tags, err := s.ArtifactTags(ctx, team)
	require.NoError(t, err)
	require.Equal(t, []string{"for review"}, tags[hex])
	commitArtifactTagsTx = original
	require.NoError(t, s.TakeArtifactOutOfReview(ctx, team, hex, []string{"for review"}, []string{"read"}))
	require.Greater(t, s.ArtifactsRevision(team), before, "take-out advertises the committed change")
}
