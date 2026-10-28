package background

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

// #10390: the indexer stores the folder a chat ran in, and a row of an older parser (no folder, version below the current one) is read again once so a past chat gets its Folder.
func TestTheIndexerStoresTheFolderAChatRanIn(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", root)
	const sid = "00000000-0000-4000-8000-000000010390"
	path := filepath.Join(root, "proj", sid+".jsonl")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(`{"type":"user","cwd":"/srv/app","timestamp":"2026-10-23T00:00:00Z","message":{"role":"user","content":"which folder?"}}`+"\n"+
		`{"type":"assistant","cwd":"/srv/app","timestamp":"2026-10-23T00:00:01Z","message":{"content":[{"type":"text","text":"app."}]}}`+"\n"), 0o644))
	info, err := os.Stat(path)
	require.NoError(t, err)

	ctx := context.Background()
	db, err := store.OpenWithKey(ctx, filepath.Join(t.TempDir(), "sessions.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	// the row as the parser before this one wrote it: same mtime, no folder, version 5
	require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: sid, SourceType: "claude", SourceFile: path, FileMtime: float64(info.ModTime().Unix()), MessageCount: 2, IndexVersion: 5}))
	require.NoError(t, ss.UpsertFTS(ctx, sid, "which folder? app."))

	require.NoError(t, NewSessionIndexer(ss, []agent.HistoryScanner{&agent.ClaudeAgent{}}, time.Hour, 0).RunOnce(ctx))
	list, err := ss.ListSessionsPaged(ctx, store.SessionListParams{Folder: "/srv/app"})
	require.NoError(t, err)
	require.Equal(t, 1, list.Total, "the old row was read again and filed under its folder")
	assert.Equal(t, "/srv/app", list.Sessions[0].WorkingDir)
}
