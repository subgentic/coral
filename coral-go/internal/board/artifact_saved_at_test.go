package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20519: the time "saved" was put on a file is kept (the merged Saved list orders by it): set when the tag is added, left alone while the file keeps it, gone when it is taken off, and set again by a new save.
func TestArtifactSavedAtFollowsTheSavedTag(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	hex := strings.Repeat("d", 64)
	at := func() string {
		m, err := s.ArtifactSavedAt(ctx, "team")
		require.NoError(t, err)
		return m[hex]
	}
	assert.Empty(t, at(), "a file never saved has no time")
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"for review"}))
	assert.Empty(t, at(), "another tag keeps no saved time")
	before := time.Now().UTC().Add(-time.Second)
	_, err := s.AddArtifactTags(ctx, "team", hex, []string{"saved"})
	require.NoError(t, err)
	first := at()
	got, perr := time.Parse(time.RFC3339, first)
	require.NoError(t, perr, first)
	assert.False(t, got.Before(before.Truncate(time.Second)), "the time is when it was saved: %s", first)
	time.Sleep(1100 * time.Millisecond) // sleep-ok: RFC 3339 has a one-second grain, so a rewrite that moved the time would show
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"saved", "read"}))
	assert.Equal(t, first, at(), "a write that keeps the tag leaves the time alone")
	require.NoError(t, s.SetArtifactTags(ctx, "team", hex, []string{"read"}))
	assert.Empty(t, at(), "taken off Saved, the time goes")
	_, err = s.AddArtifactTags(ctx, "team", hex, []string{"saved"})
	require.NoError(t, err)
	assert.NotEqual(t, first, at(), "saved again, a new time")
}
