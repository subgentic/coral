package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCleanReviewQuestion(t *testing.T) {
	q, ok := CleanReviewQuestion("  Approve this\tphone layout\n for the Goals list?  ")
	require.True(t, ok)
	assert.Equal(t, "Approve this phone layout for the Goals list?", q, "one line, whitespace folded")
	q, ok = CleanReviewQuestion("a" + string(rune(0x202e)) + "b" + string(rune(0x200b)) + "c\x1b[31m")
	require.True(t, ok)
	assert.NotContains(t, q, string(rune(0x202e)))
	assert.NotContains(t, q, string(rune(0x200b)))
	assert.NotContains(t, q, "\x1b")
	q, ok = CleanReviewQuestion(strings.Repeat("x", 300))
	require.True(t, ok)
	assert.Len(t, []rune(q), MaxReviewQuestionRunes, "cut at 140")
	q, ok = CleanReviewQuestion(strings.Repeat("é", 200))
	require.True(t, ok)
	assert.Len(t, []rune(q), MaxReviewQuestionRunes, "cut in characters, not bytes")
	for _, empty := range []string{"", "   ", "\t\n", string(rune(0x200b)), string(rune(0x3164))} {
		_, ok := CleanReviewQuestion(empty)
		assert.False(t, ok, "empty once cleaned: %q", empty)
	}
}

// Only the session that asked a question changes it (#11555, Security's condition 3).
func TestArtifactQuestionIsTheUploadingSessionsAlone(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now()
	ok, err := s.SetArtifactQuestion(ctx, "team-a", "abc", "Approve the layout?", "sess-1", now)
	require.NoError(t, err)
	assert.True(t, ok)
	ok, err = s.SetArtifactQuestion(ctx, "team-a", "abc", "Wire the money?", "sess-2", now)
	require.NoError(t, err)
	assert.False(t, ok, "another session's question does not replace it")
	got, err := s.ArtifactQuestions(ctx, "team-a")
	require.NoError(t, err)
	assert.Equal(t, "Approve the layout?", got["abc"].Question)
	ok, err = s.SetArtifactQuestion(ctx, "team-a", "abc", "Approve v2 of the layout?", "sess-1", now)
	require.NoError(t, err)
	assert.True(t, ok, "the asker may change it")
	other, err := s.ArtifactQuestions(ctx, "team-b")
	require.NoError(t, err)
	assert.Empty(t, other, "a question belongs to a board")
	// Tags are another table: an edit that keeps "for review" leaves the question (removing the tag clears it: TestArtifactQuestionIsClearedWhenTheReviewEnds).
	require.NoError(t, s.SetArtifactTags(ctx, "team-a", "abc", []string{"for review"}))
	require.NoError(t, s.SetArtifactTags(ctx, "team-a", "abc", []string{"for review", "internal"}))
	got, _ = s.ArtifactQuestions(ctx, "team-a")
	assert.Equal(t, "Approve v2 of the layout?", got["abc"].Question, "an edit of the tags does not drop it")
}

// The question goes when the review is decided or the tag is removed (#11555, Security's SHOULD B); an undone decision puts it back.
func TestArtifactQuestionIsClearedWhenTheReviewEnds(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now()
	ask := func(hex string) {
		require.NoError(t, s.SetArtifactTags(ctx, "team-a", hex, []string{"for review"}))
		_, err := s.SetArtifactQuestion(ctx, "team-a", hex, "Approve "+hex+"?", "sess-1", now)
		require.NoError(t, err)
	}
	has := func(hex string) bool {
		got, err := s.ArtifactQuestions(ctx, "team-a")
		require.NoError(t, err)
		_, ok := got[hex]
		return ok
	}

	ask("approved")
	_, _, err := s.DecideArtifactReview(ctx, "team-a", "approved", ReviewApproved, now)
	require.NoError(t, err)
	assert.False(t, has("approved"), "approved: nothing is asked any more")

	ask("changes")
	_, _, err = s.DecideArtifactReview(ctx, "team-a", "changes", ReviewChangesRequested, now)
	require.NoError(t, err)
	assert.False(t, has("changes"), "changes requested is a decision too")

	ask("untagged")
	require.NoError(t, s.SetArtifactTags(ctx, "team-a", "untagged", []string{"internal"}))
	assert.False(t, has("untagged"), "the tag was removed")
	ask("kept")
	require.NoError(t, s.SetArtifactTags(ctx, "team-a", "kept", []string{"for review", "internal"}))
	assert.True(t, has("kept"), "the tag is still there: the question stays")

	ask("superseded")
	_, err = s.SupersedeArtifactReview(ctx, "team-a", "superseded", now)
	require.NoError(t, err)
	assert.False(t, has("superseded"), "a newer version replaces it")

	ask("undone")
	ch, _, err := s.DecideArtifactReview(ctx, "team-a", "undone", ReviewApproved, now)
	require.NoError(t, err)
	require.False(t, has("undone"))
	require.NoError(t, s.UndoArtifactReview(ctx, ch))
	got, _ := s.ArtifactQuestions(ctx, "team-a")
	assert.Equal(t, "Approve undone?", got["undone"].Question, "a decision whose message could not be sent is undone with its question")
	assert.Equal(t, "sess-1", got["undone"].Session, "and its asker")
}
