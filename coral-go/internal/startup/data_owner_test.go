package startup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/dataowner"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// Task #429 at the seam: the real database, the real folder. The incident: a copy of a live sessions.db in an otherwise empty data folder woke the team's agents.

func ownerRig(t *testing.T) (*store.DB, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := storetest.Open(t, filepath.Join(dir, "sessions.db"))
	require.NoError(t, err)
	return db, dir
}

func addAgents(t *testing.T, db *store.DB, n int) {
	t.Helper()
	ss := store.NewSessionStore(db)
	for i := 0; i < n; i++ {
		id := []string{"aaaaaaaa", "bbbbbbbb", "cccccccc"}[i] + "-0000-4000-8000-000000000000"
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: id, AgentName: "agent", AgentType: "claude", WorkingDir: "/tmp"}))
	}
}

func TestAFirstStartMakesTheIdAndTheNextStartVerifies(t *testing.T) {
	db, dir := ownerRig(t)
	ctx := context.Background()
	v := verifyDataOwner(ctx, db, dir)
	assert.False(t, v.Foreign)
	assert.True(t, v.Made)
	id, err := db.DataDirID(ctx)
	require.NoError(t, err)
	assert.Len(t, id, 32)
	_, err = os.Stat(filepath.Join(dir, dataowner.FileName))
	require.NoError(t, err)
	assert.False(t, verifyDataOwner(ctx, db, dir).Foreign)
}

// The incident, replayed: a copy of a live database (with its agents, and with the id of the folder that made it) lands in an empty folder.
func TestACopyOfALiveDatabaseInAnotherFolderIsForeign(t *testing.T) {
	ctx := context.Background()
	live, liveDir := ownerRig(t)
	require.False(t, verifyDataOwner(ctx, live, liveDir).Foreign) // the live Coral's own first start made its id
	addAgents(t, live, 3)                                         // and it has run agents since
	copyPath := filepath.Join(t.TempDir(), "sessions.db")
	_, err := live.ExecContext(ctx, `VACUUM INTO ?`, copyPath) // SQLite's own copy
	require.NoError(t, err)

	copyDir := filepath.Dir(copyPath)
	copied, err := storetest.Open(t, copyPath)
	require.NoError(t, err)
	n, err := copied.ActiveSessionCount(ctx)
	require.NoError(t, err)
	require.Equal(t, 3, n, "the copy lists the team's agents")

	v := verifyDataOwner(ctx, copied, copyDir)
	assert.True(t, v.Foreign, "it carries the live folder's id and the new folder has no id file")
	assert.Equal(t, dataowner.ReasonRowOnly, v.Reason)
	_, err = os.Stat(filepath.Join(copyDir, dataowner.FileName))
	assert.True(t, os.IsNotExist(err), "a foreign start writes nothing in the folder")
}

// #12591: a database with live agents and no id, in a folder that has none, is an install from before the id upgrading in place (the operator's real folder): it is made its own, with the id in
// both places, and nothing is withheld. A copy is told by the row it carries (the test above), not by how its folder looks.
func TestAnOldDatabaseWithAgentsAndNoIdIsAnInstallUpgradingInPlaceAndIsOwned(t *testing.T) {
	ctx := context.Background()
	db, dir := ownerRig(t)
	addAgents(t, db, 2)
	v := verifyDataOwner(ctx, db, dir)
	assert.False(t, v.Foreign, "agents, no id: an install upgrading in place")
	assert.True(t, v.Made)
	id, err := db.DataDirID(ctx)
	require.NoError(t, err)
	assert.Len(t, id, 32, "the id is in the database")
	_, err = os.Stat(filepath.Join(dir, dataowner.FileName))
	assert.NoError(t, err, "and in the folder")
	assert.False(t, verifyDataOwner(ctx, db, dir).Foreign, "and the next start verifies")
}
