package opencode

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// agentFiles are the records Coral keeps for key under dataDir.
func agentFiles(dataDir, key, session string) []string {
	return []string{
		filepath.Join(dataDir, "servers", key),
		filepath.Join(storesDir(dataDir), "agents", key),
		filepath.Join(storesDir(dataDir), "last", key),
		filepath.Join(storesDir(dataDir), session),
	}
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func keepFor(t *testing.T, dataDir, key, session string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Join(dataDir, "servers", key), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dataDir, "servers", key, "opencode.db"), []byte("db"), 0o600))
	noteStore(dataDir, session, key)
	noteAgentSession(dataDir, key, session)
	persistLast(dataDir, key, Message{Role: "assistant", Text: "hello"}, func(s string) (string, bool) { return s, true })
	for _, p := range agentFiles(dataDir, key, session) {
		require.True(t, exists(p), p)
	}
}

// #11405: a deleted agent leaves nothing under its key; a sleeping one keeps everything; another agent's records are not touched.
func TestDeletingAnAgentRemovesWhatIsKeptForItAndASleepingOneKeepsIt(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	keepFor(t, cfg.DataDir, "agent-1", "ses_one111")
	keepFor(t, cfg.DataDir, "agent-2", "ses_two222")

	_, err := m.Ensure(context.Background(), "agent-1", "", "", "")
	require.NoError(t, err)
	m.Stop("agent-1") // it sleeps
	for _, p := range agentFiles(cfg.DataDir, "agent-1", "ses_one111") {
		assert.True(t, exists(p), "asleep: %s is kept", p)
	}

	require.NoError(t, m.Forget("agent-1")) // it is deleted
	for _, p := range agentFiles(cfg.DataDir, "agent-1", "ses_one111") {
		assert.False(t, exists(p), "deleted: %s is gone", p)
	}
	for _, p := range agentFiles(cfg.DataDir, "agent-2", "ses_two222") {
		assert.True(t, exists(p), "another agent's %s is not touched", p)
	}
	assert.Empty(t, m.StoredSession("agent-1"))
	_, ok := PersistedLast(cfg.DataDir, "agent-1")
	assert.False(t, ok)
	assert.NoError(t, m.Forget("agent-1"), "forgetting twice is nothing")
}

// A server that is up when the agent is deleted is stopped first, and no server is started for the key afterwards (a late wake or a history read cannot bring a record back).
func TestADeletedAgentsServerIsStoppedAndNothingStartsForItAfterwards(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	_, err := m.Ensure(context.Background(), "agent-1", "", "", "")
	require.NoError(t, err)
	_, up := m.AgentIdleSince("agent-1")
	require.True(t, up)

	require.NoError(t, m.Forget("agent-1"))
	_, up = m.AgentIdleSince("agent-1")
	assert.False(t, up, "its server is stopped")
	_, err = m.Ensure(context.Background(), "agent-1", "", "", "")
	assert.ErrorIs(t, err, errForgotten)
	msgs, ok, _ := m.ReadHistory(context.Background(), "agent-1", "")
	assert.False(t, ok)
	assert.Empty(t, msgs)
	assert.False(t, exists(filepath.Join(cfg.DataDir, "servers", "agent-1")), "no folder is made again")
	_, err = m.Ensure(context.Background(), "agent-2", "", "", "")
	assert.NoError(t, err, "another agent still starts")
}

// A link on the way to a record, or at the record, is not followed and not removed: what it points at is untouched and the error names it.
func TestALinkAmongAnAgentsRecordsIsRefusedNotFollowed(t *testing.T) {
	outside := t.TempDir()
	secret := filepath.Join(outside, "keep.txt")
	require.NoError(t, os.WriteFile(secret, []byte("not Coral's"), 0o600))
	outDir := filepath.Join(outside, "dir")
	require.NoError(t, os.MkdirAll(outDir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(outDir, "opencode.db"), []byte("x"), 0o600))

	t.Run("the record is a link", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.MkdirAll(filepath.Join(storesDir(dir), "last"), 0o700))
		link := filepath.Join(storesDir(dir), "last", "agent-1")
		if err := os.Symlink(secret, link); err != nil {
			t.Skipf("no symlinks here: %v", err)
		}
		err := removeRecords(dir, "agent-1")
		assert.ErrorIs(t, err, errLinked)
		assert.True(t, exists(secret), "the target is untouched")
		assert.True(t, exists(link), "the link is left where it is")
	})
	t.Run("the agent's folder is a link", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.MkdirAll(filepath.Join(dir, "servers"), 0o700))
		if err := os.Symlink(outDir, filepath.Join(dir, "servers", "agent-1")); err != nil {
			t.Skipf("no symlinks here: %v", err)
		}
		assert.ErrorIs(t, removeRecords(dir, "agent-1"), errLinked)
		assert.True(t, exists(filepath.Join(outDir, "opencode.db")), "nothing was removed through it")
	})
	t.Run("a folder on the way is a link", func(t *testing.T) {
		dir := t.TempDir()
		outStores := t.TempDir()
		require.NoError(t, os.MkdirAll(filepath.Join(outStores, "last"), 0o700))
		victim := filepath.Join(outStores, "last", "agent-1")
		require.NoError(t, os.WriteFile(victim, []byte("{}"), 0o600))
		if err := os.Symlink(outStores, storesDir(dir)); err != nil {
			t.Skipf("no symlinks here: %v", err)
		}
		assert.ErrorIs(t, removeRecords(dir, "agent-1"), errLinked)
		assert.True(t, exists(victim), "the folder it points at is untouched")
	})
	t.Run("a link inside the agent's folder is removed as a link, its target stays", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.MkdirAll(filepath.Join(dir, "servers", "agent-1"), 0o700))
		inner := filepath.Join(dir, "servers", "agent-1", "planted")
		if err := os.Symlink(outDir, inner); err != nil {
			t.Skipf("no symlinks here: %v", err)
		}
		assert.NoError(t, removeRecords(dir, "agent-1"))
		assert.False(t, exists(filepath.Join(dir, "servers", "agent-1")))
		assert.True(t, exists(filepath.Join(outDir, "opencode.db")), "RemoveAll does not follow it")
	})
	t.Run("a pointer that is a link is not read", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.MkdirAll(storesDir(dir), 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(outside, "ptr"), []byte("agent-1"), 0o600))
		p := filepath.Join(storesDir(dir), "ses_link111")
		if err := os.Symlink(filepath.Join(outside, "ptr"), p); err != nil {
			t.Skipf("no symlinks here: %v", err)
		}
		assert.NoError(t, removeRecords(dir, "agent-1"))
		assert.True(t, exists(p), "a link named like a pointer is left alone")
		assert.True(t, exists(filepath.Join(outside, "ptr")))
	})
}

func TestForgetOnlyTakesAnAgentKeyAndOnlyPointersThatNameThatKey(t *testing.T) {
	cfg, _ := stubConfig(t)
	m := NewManager(cfg)
	defer m.Close()
	keepFor(t, cfg.DataDir, "agent-1", "ses_one111")
	for _, bad := range []string{"", "../agent-1", "a/b", "..", "-x"} {
		assert.Error(t, m.Forget(bad), "%q", bad)
	}
	for _, p := range agentFiles(cfg.DataDir, "agent-1", "ses_one111") {
		assert.True(t, exists(p), "a refused key removed nothing: %s", p)
	}
	require.NoError(t, os.WriteFile(filepath.Join(storesDir(cfg.DataDir), "ses_other99"), []byte("agent-10"), 0o600))
	require.NoError(t, m.Forget("agent-1"))
	assert.True(t, exists(filepath.Join(storesDir(cfg.DataDir), "ses_other99")), "agent-10 is not agent-1")
}

// #11608: a Manager with no data folder refuses to forget, as Start refuses to start: with an empty folder the removals would run relative to the working folder and take a servers/<key> there.
func TestForgetWithNoDataFolderTouchesNothing(t *testing.T) {
	work := t.TempDir()
	t.Chdir(work)
	const key = "a1b2c3d4e5f6"
	require.NoError(t, os.MkdirAll(filepath.Join("servers", key), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join("servers", key, "keep.txt"), []byte("x"), 0o600))
	m := NewManager(Config{})
	err := m.Forget(key)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "data folder")
	assert.True(t, exists(filepath.Join(work, "servers", key, "keep.txt")), "a folder in the working directory is not removed")
	assert.False(t, m.isForgotten(key), "and nothing is marked forgotten")
}
