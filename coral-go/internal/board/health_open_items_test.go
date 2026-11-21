package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20495: the open items are the newest check's, with the line each was shown as; an acknowledged one, and one the newest check did not show, are not open.
func TestOpenHealthItemsAreTheNewestChecksAndUnacknowledged(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	t0 := time.Now().UTC().Truncate(time.Second)
	_, _, err := s.NoteHealthItems(ctx, "team", map[string]string{"aaaaaaaa": "1", "bbbbbbbb": "1"}, t0)
	require.NoError(t, err)
	require.NoError(t, s.NoteHealthItemTexts(ctx, "team", map[string]string{"aaaaaaaa": "[ack aaaaaaaa] A: idle.", "bbbbbbbb": "[ack bbbbbbbb] B: idle."}))
	got, err := s.ListOpenHealthItems(ctx, "team")
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "[ack aaaaaaaa] A: idle.", got[0].Text)

	require.NoError(t, s.AckHealthItem(ctx, "team", "aaaaaaaa", "Orchestrator", t0))
	got, _ = s.ListOpenHealthItems(ctx, "team")
	require.Len(t, got, 1)
	assert.Equal(t, "bbbbbbbb", got[0].ID, "an acknowledged item is not open")

	// The next check shows only C (B is gone) and A again in the same state (still acknowledged): only C is open.
	t1 := t0.Add(10 * time.Minute)
	_, _, err = s.NoteHealthItems(ctx, "team", map[string]string{"aaaaaaaa": "1", "cccccccc": "1"}, t1)
	require.NoError(t, err)
	require.NoError(t, s.NoteHealthItemTexts(ctx, "team", map[string]string{"cccccccc": "[ack cccccccc] C: asleep.\x1b[31m red"}))
	got, _ = s.ListOpenHealthItems(ctx, "team")
	require.Len(t, got, 1)
	assert.Equal(t, "cccccccc", got[0].ID)
	assert.NotContains(t, got[0].Text, "\x1b", "no terminal control is kept")

	// A changed state un-acknowledges A.
	t2 := t1.Add(10 * time.Minute)
	_, back, err := s.NoteHealthItems(ctx, "team", map[string]string{"aaaaaaaa": "2"}, t2)
	require.NoError(t, err)
	assert.True(t, back["aaaaaaaa"])
	got, _ = s.ListOpenHealthItems(ctx, "team")
	require.Len(t, got, 1)
	assert.Equal(t, "aaaaaaaa", got[0].ID)

	// The text is cut, another board is not read, and a check that showed nothing lists nothing.
	require.NoError(t, s.NoteHealthItemTexts(ctx, "team", map[string]string{"aaaaaaaa": strings.Repeat("x", 2000)}))
	got, _ = s.ListOpenHealthItems(ctx, "team")
	assert.LessOrEqual(t, len([]rune(got[0].Text)), 600)
	_, _, err = s.NoteHealthItems(ctx, "team", map[string]string{}, t2.Add(10*time.Minute))
	require.NoError(t, err)
	got, _ = s.ListOpenHealthItems(ctx, "team")
	assert.Empty(t, got, "a check that showed nothing lists nothing")
	other, err := s.ListOpenHealthItems(ctx, "other")
	require.NoError(t, err)
	assert.Empty(t, other)
}
