package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCleanArtifactNote(t *testing.T) {
	n, ok := CleanArtifactNote("  added a\tCopy all\n button  ")
	require.True(t, ok)
	assert.Equal(t, "added a Copy all button", n, "one line, whitespace folded")
	n, ok = CleanArtifactNote("a" + string(rune(0x202e)) + "b" + string(rune(0x200b)) + "c\x1b[31m")
	require.True(t, ok)
	for _, bad := range []string{string(rune(0x202e)), string(rune(0x200b)), "\x1b"} {
		assert.NotContains(t, n, bad)
	}
	n, ok = CleanArtifactNote(strings.Repeat("é", 300))
	require.True(t, ok)
	assert.Len(t, []rune(n), MaxArtifactNoteRunes, "cut at 140 characters, not bytes")
	_, ok = CleanArtifactNote("  \t\n")
	assert.False(t, ok, "empty once cleaned")
}

// The note is the uploading session's alone (#17119): another agent uploading the same bytes does not change it.
func TestArtifactNoteIsTheUploadingSessionsAlone(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now()
	require.NoError(t, s.SetArtifactNote(ctx, "d1", "added a Copy all button", "sess-1", now))
	require.NoError(t, s.SetArtifactNote(ctx, "d1", "someone else's words", "sess-2", now))
	got, err := s.ArtifactNotes(ctx, []string{"d1", "d2"})
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"d1": "added a Copy all button"}, got, "the first session's note stands; a digest with none is absent")
	require.NoError(t, s.SetArtifactNote(ctx, "d1", "fixed the date", "sess-1", now))
	got, _ = s.ArtifactNotes(ctx, []string{"d1"})
	assert.Equal(t, "fixed the date", got["d1"], "its own session may change it")
}
