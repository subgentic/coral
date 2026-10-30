package store_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #408: the CLI path a terminal session was launched with is kept in the database, so a wrapper script that is the CLI is still recognised after a Coral restart.
func TestTheLaunchCLIIsKeptWithTheSessionAcrossAReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	ctx := context.Background()
	db, err := store.OpenWithKey(ctx, path, "")
	require.NoError(t, err)
	s := store.NewSessionStore(db)

	assert.Empty(t, s.LaunchCLI(ctx, "claude-a"), "a session from before this was kept: no path")
	require.NoError(t, s.SetLaunchCLI(ctx, "claude-a", "/opt/tools/stub.sh"))
	require.NoError(t, s.SetLaunchCLI(ctx, "claude-b", "/opt/tools/other.sh"))
	assert.Equal(t, "/opt/tools/stub.sh", s.LaunchCLI(ctx, "claude-a"))

	require.NoError(t, s.SetLaunchCLI(ctx, "claude-a", "/opt/tools/new.sh"))
	assert.Equal(t, "/opt/tools/new.sh", s.LaunchCLI(ctx, "claude-a"), "a record by the Operator replaces the launch's")

	require.NoError(t, db.Close())
	again, err := store.OpenWithKey(ctx, path, "") // the server restarted over the same database
	require.NoError(t, err)
	t.Cleanup(func() { again.Close() })
	s2 := store.NewSessionStore(again)
	assert.Equal(t, "/opt/tools/new.sh", s2.LaunchCLI(ctx, "claude-a"))
	assert.Equal(t, "/opt/tools/other.sh", s2.LaunchCLI(ctx, "claude-b"))
	assert.Empty(t, s2.LaunchCLI(ctx, "claude-c"), "another session has none")

	require.NoError(t, s2.SetLaunchCLI(ctx, "claude-a", ""))
	assert.Empty(t, s2.LaunchCLI(ctx, "claude-a"), "an empty path removes it")
	require.NoError(t, s2.SetLaunchCLI(ctx, "", "/x"), "no session name: nothing is kept, no error")
}

// The row goes with the session: when it ends (kill or close) its CLI path is removed, the others stay, and a later session with the same name keeps what it is launched with.
func TestTheLaunchCLIGoesWhenTheSessionEnds(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenWithKey(ctx, filepath.Join(t.TempDir(), "test.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	s := store.NewSessionStore(db)
	for _, id := range []string{"s-one", "s-two"} {
		require.NoError(t, s.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "a-" + id, WorkingDir: "/tmp"}))
		require.NoError(t, s.SetLaunchCLI(ctx, "claude-"+id, "/opt/"+id+".sh"))
	}
	require.NoError(t, s.UnregisterLiveSession(ctx, "s-one"))
	assert.Empty(t, s.LaunchCLI(ctx, "claude-s-one"), "its session ended")
	assert.Equal(t, "/opt/s-two.sh", s.LaunchCLI(ctx, "claude-s-two"), "another session keeps its own")

	// the same name again (a session id reused by a restart or a resume): it takes the path of ITS launch, never the old one
	require.NoError(t, s.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "s-one", AgentType: "claude", AgentName: "a-s-one", WorkingDir: "/tmp"}))
	assert.Empty(t, s.LaunchCLI(ctx, "claude-s-one"), "nothing is inherited")
	require.NoError(t, s.SetLaunchCLI(ctx, "claude-s-one", "/opt/new.sh"))
	assert.Equal(t, "/opt/new.sh", s.LaunchCLI(ctx, "claude-s-one"))
}

// Dead sessions are pruned: a row whose session is not active is removed with the cleanup, one whose session is active stays, and a reopen shows the deleted one gone.
func TestPruneLaunchCLIRemovesTheRowsOfSessionsThatAreNotActive(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := store.OpenWithKey(ctx, path, "")
	require.NoError(t, err)
	s := store.NewSessionStore(db)
	require.NoError(t, s.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "alive", AgentType: "claude", AgentName: "a", WorkingDir: "/tmp"}))
	require.NoError(t, s.SetLaunchCLI(ctx, "claude-alive", "/home/someone/bin/alive.sh"))
	require.NoError(t, s.SetLaunchCLI(ctx, "claude-never-registered", "/home/someone/bin/x.sh"))
	_, err = s.CleanupOrphanedSleeping(ctx)
	require.NoError(t, err)
	assert.Equal(t, "/home/someone/bin/alive.sh", s.LaunchCLI(ctx, "claude-alive"))
	assert.Empty(t, s.LaunchCLI(ctx, "claude-never-registered"), "no active session has this name")

	require.NoError(t, s.UnregisterLiveSession(ctx, "alive"))
	require.NoError(t, db.Close())
	again, err := store.OpenWithKey(ctx, path, "")
	require.NoError(t, err)
	t.Cleanup(func() { again.Close() })
	assert.Empty(t, store.NewSessionStore(again).LaunchCLI(ctx, "claude-alive"), "after a reopen the ended session's row is still gone")
}
