package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// QA Reviewer 2's SHOULDs on #13231 (the store's rules of sending a file for review): "saved" is the Operator's and stays through a re-send; a file already waiting is left exactly as it is (its time and its marks);
// the sent time does not move while the tag stays; the five-tag limit is checked after the old round's tags are cleared; and a file without the tag shows no time.
func TestAFileSentForReviewKeepsSavedLeavesAWaitingFileAloneAndRespectsTheFiveTagLimit(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	hex := strings.Repeat("d", 64)
	t1, t2 := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC), time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	tags := func() []string { all, err := s.ArtifactTags(ctx, "team"); require.NoError(t, err); return all[hex] }
	sentAt := func() (string, bool) {
		m, err := s.ArtifactReviewSent(ctx, "team")
		require.NoError(t, err)
		at, ok := m[hex]
		return at, ok
	}

	// a decided file with the Operator's own "saved" and an unrelated tag: a new round keeps those two and drops the decision and the mark
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"approved", "read", "saved", "internal"}))
	got, was, err := s.StartArtifactReview(ctx, "team", hex, t1)
	require.NoError(t, err)
	assert.Equal(t, []string{"for review", "internal", "saved"}, got, "'saved' is the Operator's: it stays; approved and read go")
	assert.Equal(t, "approved", was)
	first, ok := sentAt()
	require.True(t, ok)
	assert.Equal(t, t1.Format(time.RFC3339), first)

	// sent again while it waits: nothing changes, not the tags, the marks or the time
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"for review", "internal", "read", "saved"})) // the Operator opened it meanwhile
	got, was, err = s.StartArtifactReview(ctx, "team", hex, t2)
	require.NoError(t, err)
	assert.Equal(t, []string{"for review", "internal", "read", "saved"}, got, "a waiting file is not made a new round: 'read' stays")
	assert.Equal(t, "", was)
	assert.Equal(t, []string{"for review", "internal", "read", "saved"}, tags())
	at, _ := sentAt()
	assert.Equal(t, first, at, "its time did not move")

	// even a waiting file that still carries an old decision is left alone (it is not a new round): nothing is cleared and no earlier decision is reported
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"approved", "for review", "internal", "read", "saved"}))
	got, was, err = s.StartArtifactReview(ctx, "team", hex, t2)
	require.NoError(t, err)
	assert.Equal(t, []string{"approved", "for review", "internal", "read", "saved"}, got)
	assert.Equal(t, "", was, "no round started: no earlier decision to report")
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"for review", "internal", "read", "saved"}))

	// the sent time does not move while the tag stays, whoever writes the tags
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"for review", "internal"}))
	_, err = s.AddArtifactTags(ctx, "team", hex, []string{"for review", "extra"})
	require.NoError(t, err)
	at, _ = sentAt()
	assert.Equal(t, first, at, "a write that keeps the tag keeps the time")

	// the tag goes (the tag editor, a decision): no time is shown for a row without the tag (the page reads it only with the tag); a new send sets it again
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"internal"}))
	got, _, err = s.StartArtifactReview(ctx, "team", hex, t2)
	require.NoError(t, err)
	assert.Contains(t, got, "for review")
	at, _ = sentAt()
	assert.Equal(t, t2.Format(time.RFC3339), at, "a new send after the tag was off is a new time")

	// five tags: a file with five others takes no sixth; one whose old round frees room does
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"a", "b", "c", "d", "e"}))
	_, _, err = s.StartArtifactReview(ctx, "team", hex, t2)
	require.ErrorIs(t, err, ErrArtifactTag)
	assert.Equal(t, []string{"a", "b", "c", "d", "e"}, tags(), "a refused send changed nothing")
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"approved", "a", "b", "c", "d"}))
	got, _, err = s.StartArtifactReview(ctx, "team", hex, t2)
	require.NoError(t, err, "approved goes, so the review tag fits")
	assert.Len(t, got, 5)
	assert.Contains(t, got, "for review")
	assert.NotContains(t, got, "approved")
}
