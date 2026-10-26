package board

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8583 (Goal #61): artifact tags: lowercase words of letters, digits, spaces and hyphens, 24 characters at most, five on an artifact.
func TestNormalizeArtifactTag(t *testing.T) {
	for in, want := range map[string]string{
		"for review":            "for review",
		"  For   Review ":       "for review",
		"a\tb\nc":               "a b c",
		"INTERNAL":              "internal",
		"q4-report":             "q4-report",
		"évidence":              "évidence",
		strings.Repeat("a", 24): strings.Repeat("a", 24),
	} {
		got, ok := NormalizeArtifactTag(in)
		assert.True(t, ok, "%q", in)
		assert.Equal(t, want, got, "%q", in)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("a", 25), "a,b", "a/b", "tag!", "a\u0000b", "a_b", "<x>", "📎"} {
		_, ok := NormalizeArtifactTag(bad)
		assert.False(t, ok, "%q", bad)
	}
}

func TestNormalizeArtifactTagsIsStrictAndCleanIsLenient(t *testing.T) {
	got, err := NormalizeArtifactTags([]string{"For Review", "internal", "for  review", "Final"})
	require.NoError(t, err)
	assert.Equal(t, []string{"for review", "internal", "final"}, got, "normalised, each once, in the order given")

	_, err = NormalizeArtifactTags([]string{"ok", "no way!"})
	assert.ErrorIs(t, err, ErrArtifactTag)
	assert.ErrorContains(t, err, `"no way!"`)
	_, err = NormalizeArtifactTags([]string{"a", "b", "c", "d", "e", "f"})
	assert.ErrorIs(t, err, ErrArtifactTag, "six is over the cap")
	five, err := NormalizeArtifactTags([]string{"a", "b", "c", "d", "e", "a"})
	require.NoError(t, err)
	assert.Len(t, five, 5, "a repeat is not a sixth")
	empty, err := NormalizeArtifactTags(nil)
	require.NoError(t, err)
	assert.Empty(t, empty)

	assert.Equal(t, []string{"for review", "final"}, CleanArtifactTags([]string{"For Review", "no way!", "for review", "", "final"}), "a word that is not a tag is left out")
	assert.Len(t, CleanArtifactTags([]string{"a", "b", "c", "d", "e", "f", "g"}), 5, "the ones past five are left off")
}

func TestArtifactTagsAreAPerBoardSetOfAStoredObject(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const obj = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	got, err := s.ArtifactTags(ctx, "alpha")
	require.NoError(t, err)
	assert.Empty(t, got)

	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"internal", "for review"}))
	got, err = s.ArtifactTags(ctx, "alpha")
	require.NoError(t, err)
	assert.Equal(t, map[string][]string{obj: {"for review", "internal"}}, got, "sorted")
	other, err := s.ArtifactTags(ctx, "beta")
	require.NoError(t, err)
	assert.Empty(t, other, "another team that holds the same bytes has its own tags")

	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, []string{"final"}))
	got, _ = s.ArtifactTags(ctx, "alpha")
	assert.Equal(t, []string{"final"}, got[obj], "set replaces")
	require.NoError(t, s.SetArtifactTags(ctx, "alpha", obj, nil))
	got, _ = s.ArtifactTags(ctx, "alpha")
	assert.Empty(t, got, "set with none clears")

	have, err := s.AddArtifactTags(ctx, "alpha", obj, []string{"draft", "internal"})
	require.NoError(t, err)
	assert.Equal(t, []string{"draft", "internal"}, have)
	have, err = s.AddArtifactTags(ctx, "alpha", obj, []string{"internal", "for review", "final", "a", "b", "c"})
	require.NoError(t, err)
	assert.Len(t, have, MaxArtifactTags, "add stops at five in all")
	assert.Contains(t, have, "draft")
	assert.Contains(t, have, "internal")
}

// AddArtifactTags names an object by its id without checking that it exists (a manifest, an upload), so one board's rows are bounded (#8623).
func TestAddArtifactTagsStopsAtTheBoardsRowCap(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.db.ExecContext(ctx, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO artifact_tags (board_id, hex, tag) SELECT 'alpha', printf('%064d', i), 'x' FROM n`, MaxBoardArtifactTagRows-1)
	require.NoError(t, err)
	count := func(board string) int {
		var n int
		require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM artifact_tags WHERE board_id = ?`, board))
		return n
	}
	require.Equal(t, MaxBoardArtifactTagRows-1, count("alpha"))

	const fresh = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	have, err := s.AddArtifactTags(ctx, "alpha", fresh, []string{"one", "two", "three"})
	require.NoError(t, err)
	assert.Equal(t, []string{"one"}, have, "one row is left, the rest is left off")
	assert.Equal(t, MaxBoardArtifactTagRows, count("alpha"))
	have, err = s.AddArtifactTags(ctx, "alpha", fresh, []string{"four"})
	require.NoError(t, err)
	assert.Equal(t, []string{"one"}, have, "a full board takes no more")
	assert.Equal(t, MaxBoardArtifactTagRows, count("alpha"))

	have, err = s.AddArtifactTags(ctx, "beta", fresh, []string{"one", "two"})
	require.NoError(t, err)
	assert.Equal(t, []string{"one", "two"}, have, "another board has its own rows")
}

func TestDeletingABoardDeletesItsArtifactTags(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const obj = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
	_, err := s.Subscribe(ctx, "doomed", "A", "Dev", "a-session", nil, "all")
	require.NoError(t, err)
	require.NoError(t, s.SetArtifactTags(ctx, "doomed", obj, []string{"for review"}))
	require.NoError(t, s.SetArtifactTags(ctx, "kept", obj, []string{"internal"}))
	require.NoError(t, s.DeleteProject(ctx, "doomed"))
	got, _ := s.ArtifactTags(ctx, "doomed")
	assert.Empty(t, got, "a board made again under the name inherits none")
	got, _ = s.ArtifactTags(ctx, "kept")
	assert.Equal(t, []string{"internal"}, got[obj], "another board's are left")
}
