package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// #11970 (QA's SHOULD on round 3): the upsert keeps an agent name that was recorded when a later index of the same chat has none (the agent is gone), a new name replaces it, and every other
// column follows the newest index.
func TestUpsertSessionIndexKeepsARecordedAgentName(t *testing.T) {
	ctx := context.Background()
	db, err := OpenWithKey(ctx, filepath.Join(t.TempDir(), "idx.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := NewSessionStore(db)
	row := func(name, display string, msgs int, mtime float64) *SessionIndex {
		return &SessionIndex{SessionID: "s1", SourceType: "claude", SourceFile: "/h/s1.jsonl", MessageCount: msgs, AgentName: name, DisplayName: display, FileMtime: mtime}
	}
	got := func() SessionIndex {
		var r SessionIndex
		require.NoError(t, db.GetContext(ctx, &r, `SELECT session_id, source_type, source_file, message_count, COALESCE(agent_name,'') AS agent_name, COALESCE(display_name,'') AS display_name, file_mtime FROM session_index WHERE session_id = 's1'`))
		return r
	}
	require.NoError(t, ss.UpsertSessionIndex(ctx, row("dev", "Dev", 2, 1)))
	require.NoError(t, ss.UpsertSessionIndex(ctx, row("", "", 5, 2))) // the agent is gone, the CLI wrote more on exit
	r := got()
	require.Equal(t, "dev", r.AgentName, "a recorded name stays")
	require.Equal(t, "Dev", r.DisplayName)
	require.Equal(t, 5, r.MessageCount, "the rest follows the newest index")
	require.EqualValues(t, 2, r.FileMtime)
	require.NoError(t, ss.UpsertSessionIndex(ctx, row("qa", "QA", 6, 3))) // a later agent owns the session
	r = got()
	require.Equal(t, "qa", r.AgentName)
	require.Equal(t, "QA", r.DisplayName)
	// a chat that never had a name stays without one
	other := &SessionIndex{SessionID: "s2", SourceType: "codex", SourceFile: "/h/s2", FileMtime: 1}
	require.NoError(t, ss.UpsertSessionIndex(ctx, other))
	require.NoError(t, ss.UpsertSessionIndex(ctx, other))
	var n string
	require.NoError(t, db.GetContext(ctx, &n, `SELECT COALESCE(agent_name,'') FROM session_index WHERE session_id = 's2'`))
	require.Equal(t, "", n)
}
