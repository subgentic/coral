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

// #11092 (Pi parity rows 3 and 17): a Pi agent Coral launched keeps its session in <data dir>/pi-sessions/<Coral session id>/, in Pi 1.4.0's real shape. One indexer pass puts it in the History
// index under that session id, with its first message, its summary and its words in the search table.
func TestIndexerListsAndSearchesACoralLaunchedPiChat(t *testing.T) {
	ctx := context.Background()
	data := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", data)
	const sid = "11111111-2222-4333-8444-555555555555"
	fixture, err := os.ReadFile(filepath.Join("..", "jsonl", "testdata", "pi-1.4.0", "session.jsonl"))
	require.NoError(t, err)
	dir := filepath.Join(data, "pi-sessions", sid)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "2026-10-29T19-44-35-010Z_00000000-0000-4000-8000-0000000000f1.jsonl"), fixture, 0o600))

	db, err := store.OpenWithKey(ctx, filepath.Join(t.TempDir(), "sessions.db"), "")
	require.NoError(t, err)
	defer db.Close()
	idx := NewSessionIndexer(store.NewSessionStore(db), []agent.HistoryScanner{&agent.PiAgent{}}, time.Hour, 0)
	require.NoError(t, idx.RunOnce(ctx))

	var row struct {
		SourceType string `db:"source_type"`
		First      string `db:"first_user_message"`
		Count      int    `db:"message_count"`
	}
	require.NoError(t, db.GetContext(ctx, &row, `SELECT source_type, COALESCE(first_user_message, '') AS first_user_message, message_count FROM session_index WHERE session_id = ?`, sid))
	assert.Equal(t, "pi", row.SourceType)
	assert.Equal(t, "FIXTURE-USER-1 question", row.First)
	assert.Equal(t, 7, row.Count)
	var hits int
	require.NoError(t, db.GetContext(ctx, &hits, `SELECT COUNT(*) FROM session_fts WHERE session_id = ? AND session_fts MATCH ?`, sid, `"FIXTURE" AND "ASSISTANT"`))
	assert.Greater(t, hits, 0, "what the Pi agent said is searchable")
}
