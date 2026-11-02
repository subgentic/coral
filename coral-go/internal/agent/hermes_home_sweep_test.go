package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11949 (Security's SHOULD on #11936): a home no session record reaches (a launch that failed after the home was made, a crash, a record deleted by hand) holds a copy of the person's .env. A sweep removes the
// homes whose name is not a live or sleeping session and that are older than a day, and nothing else.
func TestSweepHermesHomes(t *testing.T) {
	r := hermesRig(t)
	const live, orphan, young, other = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01", "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02", "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c03", "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c04"
	now := time.Now()
	old := now.Add(-25 * time.Hour)
	make := func(team, sid string, mtime time.Time) string {
		home, err := PrepareHermesHome(r.data, team, sid, r.person, now)
		require.NoError(t, err)
		require.NoError(t, os.Chtimes(home, mtime, mtime))
		return home
	}
	liveHome := make("team-a", live, old)
	orphanHome := make("team-a", orphan, old)
	youngHome := make("team-a", young, now.Add(-2*time.Hour))
	otherTeamOrphan := make("team-b", other, old)
	// a stray file, a folder whose name is not a session id, and a link, in a team's folder
	team := HermesTeamHome(r.data, "team-a")
	require.NoError(t, os.WriteFile(filepath.Join(team, "stray.txt"), []byte("x"), 0o600))
	junk := filepath.Join(team, "not-a-session")
	require.NoError(t, os.MkdirAll(junk, 0o700))
	require.NoError(t, os.Chtimes(junk, old, old))
	keep := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(keep, "f"), []byte("keep"), 0o600))
	link := filepath.Join(team, "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c05")
	require.NoError(t, os.Symlink(keep, link))
	require.NoError(t, os.Chtimes(keep, old, old)) // what the link points at is old too: still not followed

	removed := SweepHermesHomes(r.data, func(id string) bool { return id == live }, 24*time.Hour, now)
	assert.Equal(t, 3, removed, "the two orphans and the junk folder")

	exists := func(p string) bool { _, err := os.Lstat(p); return err == nil }
	assert.True(t, exists(liveHome), "a live or sleeping session's home stays")
	assert.False(t, exists(orphanHome))
	assert.True(t, exists(youngHome), "a home under a day old may belong to a launch in progress")
	assert.False(t, exists(otherTeamOrphan), "in every team's folder")
	assert.False(t, exists(junk))
	assert.True(t, exists(link), "a link is never removed or followed")
	_, err := os.Stat(filepath.Join(keep, "f"))
	assert.NoError(t, err, "what the link pointed at is untouched")
	assert.True(t, exists(filepath.Join(team, "stray.txt")), "files that are not folders are left")
}

// A link in place of hermes-homes or of a team's folder is never walked through.
func TestSweepHermesHomesDoesNotFollowALinkedParent(t *testing.T) {
	const orphan = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02"
	old := time.Now().Add(-48 * time.Hour)
	for _, level := range []string{"hermes-homes", "team"} {
		t.Run(level, func(t *testing.T) {
			r := hermesRig(t)
			keep := t.TempDir()
			victim := filepath.Join(keep, orphan)
			require.NoError(t, os.MkdirAll(victim, 0o700))
			require.NoError(t, os.Chtimes(victim, old, old))
			if level == "team" {
				require.NoError(t, os.MkdirAll(filepath.Join(r.data, hermesHomesFolder), 0o700))
				require.NoError(t, os.Symlink(keep, HermesTeamHome(r.data, "t")))
			} else {
				require.NoError(t, os.Symlink(keep, filepath.Join(r.data, hermesHomesFolder)))
			}
			assert.Zero(t, SweepHermesHomes(r.data, func(string) bool { return false }, 24*time.Hour, time.Now()))
			_, err := os.Stat(victim)
			assert.NoError(t, err, "nothing was removed through the link")
		})
	}
	assert.Zero(t, SweepHermesHomes(t.TempDir(), func(string) bool { return false }, 24*time.Hour, time.Now()), "no hermes-homes folder: nothing to do")
	assert.Zero(t, SweepHermesHomes("", func(string) bool { return false }, 24*time.Hour, time.Now()))
}
