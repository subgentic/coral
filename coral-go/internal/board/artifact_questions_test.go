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
	// Tags are another table: setting or clearing them leaves the question.
	require.NoError(t, s.SetArtifactTags(ctx, "team-a", "abc", []string{"for review"}))
	require.NoError(t, s.SetArtifactTags(ctx, "team-a", "abc", nil))
	got, _ = s.ArtifactQuestions(ctx, "team-a")
	assert.Equal(t, "Approve v2 of the layout?", got["abc"].Question, "an edit of the tags does not drop it")
}
