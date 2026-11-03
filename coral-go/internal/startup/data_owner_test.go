package startup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/dataowner"
	"github.com/subgentic/coral/internal/ptymanager"
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

// #12591, the operator's rule: any folder Coral itself left behind (no id yet) opens on the new build as OWNED with its agents recovered. A folder built by the previous release's start: the database lists
// live agents, nothing in it carries an id. The new build's start makes the id, withholds nothing, and the recovery that marks the agents Coral stopped (for the auto-wake) runs.
func TestAFolderTheLastReleaseLeftBehindOpensOwnedWithItsAgentsRecovered(t *testing.T) {
	ctx := context.Background()
	db, dir := ownerRig(t)
	for _, name := range []string{"api_key", "cli-token", "app.log", "tray.log", "messageboard.db"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600))
	}
	addAgents(t, db, 3) // the team: awake when the last release stopped
	t.Cleanup(func() { ptymanager.SetForeign(false); dataowner.ResetCopyWarningForTest() })

	v := settleDataOwner(ctx, db, dir)
	assert.False(t, v.Foreign, "no id: an upgrade in place")
	assert.False(t, ptymanager.Foreign(), "nothing is withheld")
	assert.Empty(t, dataowner.CopyWarning(), "and there is no warning")
	id, err := db.DataDirID(ctx)
	require.NoError(t, err)
	assert.Len(t, id, 32, "the id is made, silently")

	reconcileOrphanedSessions(ctx, db, background.NewPTYRuntime(ptymanager.NewPTYBackend()), true)
	all, err := store.NewSessionStore(db).GetAllLiveSessions(ctx)
	require.NoError(t, err)
	require.Len(t, all, 3)
	for _, ls := range all {
		require.NotNil(t, ls.SleepReason, "every agent is recovered for the auto-wake")
		assert.Equal(t, store.SleepReasonCoralStopped, *ls.SleepReason)
	}
}

// A copy (the id's row without the id file) only warns: Coral starts as usual, the warning is there for the dashboard, and the press adopts the folder in place.
func TestACopyOnlyWarnsAndTheButtonAdoptsItInPlace(t *testing.T) {
	ctx := context.Background()
	t.Cleanup(func() { ptymanager.SetForeign(false); dataowner.ResetCopyWarningForTest() })
	live, liveDir := ownerRig(t)
	require.False(t, settleDataOwner(ctx, live, liveDir).Foreign)
	addAgents(t, live, 2)
	copyPath := filepath.Join(t.TempDir(), "sessions.db")
	_, err := live.ExecContext(ctx, `VACUUM INTO ?`, copyPath)
	require.NoError(t, err)
	copied, err := storetest.Open(t, copyPath)
	require.NoError(t, err)
	copyDir := filepath.Dir(copyPath)

	v := settleDataOwner(ctx, copied, copyDir)
	assert.True(t, v.Foreign, "the ids show a copy")
	assert.False(t, ptymanager.Foreign(), "and Coral still runs as usual: nothing is withheld")
	assert.Equal(t, dataowner.Notice, dataowner.CopyWarning(), "the dashboard is told")

	adopted, err := dataowner.AdoptPending(ctx)
	require.NoError(t, err)
	assert.True(t, adopted)
	assert.Empty(t, dataowner.CopyWarning())
	assert.False(t, verifyDataOwner(ctx, copied, copyDir).Foreign, "the folder is its own now, with no restart")
}

// Start asks settleDataOwner and never lets the verdict gate recovery: no `ownership.Foreign` branch, no SetForeign(true) in the startup source (#12591).
func TestStartNeverGatesOnTheDataOwnerVerdict(t *testing.T) {
	src, err := os.ReadFile("startup.go")
	require.NoError(t, err)
	text := string(src)
	assert.Contains(t, text, "settleDataOwner(ctx, db, cfg.CoralDir())")
	assert.NotContains(t, text, "ownership.Foreign", "the verdict does not decide whether recovery runs")
	assert.NotContains(t, text, "SetForeign(true)")
	assert.NotContains(t, text, "SetForeign(ownership")
	own, err := os.ReadFile("startup_dataowner.go")
	require.NoError(t, err)
	assert.Contains(t, string(own), "ptymanager.SetForeign(false)")
	assert.NotContains(t, string(own), "SetForeign(v.Foreign)")
}
