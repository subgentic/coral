package store

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13208: a skill an agent read is one row per session and skill (a second read counts, it does not add a row), one agent's record is its own, and a session keeps at most skillsLoadedPerSession of them.
func TestALoadRecordCountsRepeatsKeepsSessionsApartAndIsBounded(t *testing.T) {
	ctx, ss, _ := skillStore(t)
	r := SkillRow{ID: "s1", Name: "notes", Version: 1, Digest: "d1"}
	require.NoError(t, ss.RecordSkillLoad(ctx, "sess-a", r))
	r.Version, r.Digest = 2, "d2"
	require.NoError(t, ss.RecordSkillLoad(ctx, "sess-a", r))
	require.NoError(t, ss.RecordSkillLoad(ctx, "", r)) // no session: nothing kept

	got, err := ss.LoadedSkills(ctx, "sess-a")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, 2, got[0].Loads)
	assert.Equal(t, 2, got[0].Version, "the newest version it read")
	other, err := ss.LoadedSkills(ctx, "sess-b")
	require.NoError(t, err)
	assert.NotNil(t, other)
	assert.Empty(t, other)

	for i := 0; i < skillsLoadedPerSession+15; i++ {
		require.NoError(t, ss.RecordSkillLoad(ctx, "sess-c", SkillRow{ID: fmt.Sprintf("k%03d", i), Name: fmt.Sprintf("n%03d", i), Version: 1, Digest: "d"}))
	}
	got, err = ss.LoadedSkills(ctx, "sess-c")
	require.NoError(t, err)
	assert.Len(t, got, skillsLoadedPerSession)
	assert.Equal(t, "k114", got[0].SkillID, "the newest first; the oldest were dropped")
	again, err := ss.LoadedSkills(ctx, "sess-a")
	require.NoError(t, err)
	assert.Len(t, again, 1, "another session's cap does not touch this one")
}
