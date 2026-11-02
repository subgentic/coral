package startup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

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

// An OLD database (no id yet) copied into a bare folder is foreign too; the same database in its established folder is adopted.
func TestAnOldDatabaseWithAgentsInABareFolderIsForeignButInItsOwnFolderIsAdopted(t *testing.T) {
	ctx := context.Background()
	db, dir := ownerRig(t)
	addAgents(t, db, 2)
	v := verifyDataOwner(ctx, db, dir)
	assert.True(t, v.Foreign, "agents, no id, and a folder with nothing else in it")
	assert.Equal(t, dataowner.ReasonBare, v.Reason)

	// the operator's step for a deliberate restore: stop, adopt, start
	require.NoError(t, AdoptDataDir(ctx, db, dir))
	assert.False(t, verifyDataOwner(ctx, db, dir).Foreign)
}

// After the upgrade: an install with agents but no board message, in its established folder, is not mistaken for a copy when the database shows earlier use (a setting, or a session older than a day).
func TestAnInstallWithAgentsButNoBoardMessagesIsNotForeignAfterTheUpgrade(t *testing.T) {
	ctx := context.Background()
	establish := func(t *testing.T, dir string) {
		t.Helper()
		key := filepath.Join(dir, "api_key")
		require.NoError(t, os.WriteFile(key, []byte("k"), 0o600))
		old := time.Now().Add(-2 * time.Hour)
		require.NoError(t, os.Chtimes(key, old, old))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "app.log"), []byte("log"), 0o600))
	}

	t.Run("a session older than a day", func(t *testing.T) {
		db, dir := ownerRig(t)
		establish(t, dir)
		ss := store.NewSessionStore(db)
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "aaaaaaaa-0000-4000-8000-000000000000", AgentName: "agent", AgentType: "claude", WorkingDir: "/tmp",
			CreatedAt: time.Now().UTC().Add(-48 * time.Hour).Format(store.ISOFormat)}))
		v := verifyDataOwner(ctx, db, dir)
		assert.False(t, v.Foreign)
		assert.True(t, v.Made)
	})

	t.Run("a user_settings row", func(t *testing.T) {
		db, dir := ownerRig(t)
		establish(t, dir)
		addAgents(t, db, 1)
		require.NoError(t, store.NewSessionStore(db).SetSetting(ctx, "theme", "dark"))
		assert.False(t, verifyDataOwner(ctx, db, dir).Foreign)
	})

	t.Run("nothing shows earlier use", func(t *testing.T) {
		db, dir := ownerRig(t)
		establish(t, dir)
		addAgents(t, db, 1) // registered just now, and no setting
		has, err := db.HasUserSettings(ctx)
		require.NoError(t, err)
		require.False(t, has, "the rig database has no user_settings row")
		v := verifyDataOwner(ctx, db, dir)
		assert.True(t, v.Foreign)
		assert.Equal(t, dataowner.ReasonBare, v.Reason)
	})

	t.Run("the age of a session is read from the stored text", func(t *testing.T) {
		db, _ := ownerRig(t)
		ss := store.NewSessionStore(db)
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "bbbbbbbb-0000-4000-8000-000000000000", AgentName: "agent", AgentType: "claude", WorkingDir: "/tmp",
			CreatedAt: time.Now().UTC().Add(-2 * time.Hour).Format(store.ISOFormat)}))
		old, err := db.HasActiveSessionOlderThan(ctx, time.Now().Add(-24*time.Hour))
		require.NoError(t, err)
		assert.False(t, old, "two hours old is not older than a day")
		old, err = db.HasActiveSessionOlderThan(ctx, time.Now().Add(-time.Hour))
		require.NoError(t, err)
		assert.True(t, old)
	})
}
