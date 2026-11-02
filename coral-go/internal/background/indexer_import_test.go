package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

func importFixture(t *testing.T) (context.Context, *store.SessionStore, *fakeScanner, *SessionIndexer) {
	ctx := context.Background()
	db, err := store.OpenWithKey(ctx, filepath.Join(t.TempDir(), "sessions.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	fs := &fakeScanner{sessions: []agent.IndexedSession{
		{SessionID: "mine", SourceType: "claude", SourceFile: "/h/mine.jsonl", MessageCount: 2, FileMtime: 1, FTSBody: "mine body"},
		{SessionID: "old-claude", SourceType: "claude", SourceFile: "/h/old.jsonl", MessageCount: 2, FileMtime: 2, FTSBody: "private old text"},
		{SessionID: "old-codex", SourceType: "codex", SourceFile: "/h/codex.jsonl", MessageCount: 2, FileMtime: 3, FTSBody: "private codex text"},
	}}
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "mine", AgentType: "claude", AgentName: "dev", WorkingDir: "/repo"}))
	return ctx, ss, fs, NewSessionIndexer(ss, []agent.HistoryScanner{fs}, time.Hour, 0)
}

func indexedIDs(t *testing.T, ss *store.SessionStore) []string {
	known, err := ss.GetIndexedMtimes(context.Background())
	require.NoError(t, err)
	var out []string
	for f := range known {
		out = append(out, filepath.Base(f))
	}
	return out
}

// #11970: a brand-new Coral indexes only the chats of agents it launched. The Claude Code and Codex history already on the
// computer is counted (so the button can say how many) but nothing of it, text included, is stored until the person imports.
func TestAFreshCoralListsOnlyTheChatsItStarted(t *testing.T) {
	ctx, ss, _, idx := importFixture(t)
	require.NoError(t, idx.RunOnce(ctx))
	require.ElementsMatch(t, []string{"mine.jsonl"}, indexedIDs(t, ss))
	settings, err := ss.GetSettings(ctx)
	require.NoError(t, err)
	require.NotContains(t, settings, "history_import", "a first pass writes no setting: only the person's choice is recorded")
	var texts int
	require.NoError(t, ss.DB().GetContext(ctx, &texts, `SELECT COUNT(*) FROM session_fts WHERE session_fts MATCH 'private'`))
	require.Zero(t, texts, "the text of a chat Coral did not start is not stored")
	counts, err := ss.UnimportedCounts(ctx)
	require.NoError(t, err)
	require.Equal(t, map[string]int{"claude": 1, "codex": 1}, counts)

	require.NoError(t, idx.RunOnce(ctx)) // a second pass keeps the same answer
	counts, _ = ss.UnimportedCounts(ctx)
	require.Equal(t, map[string]int{"claude": 1, "codex": 1}, counts)
}

// The import lists what was held back at the next pass, and the choice stays.
func TestImportingEarlierChatsListsThem(t *testing.T) {
	ctx, ss, _, idx := importFixture(t)
	require.NoError(t, idx.RunOnce(ctx))
	require.NoError(t, ss.ImportEarlierChats(ctx))
	require.NoError(t, idx.RunOnce(ctx))
	require.ElementsMatch(t, []string{"mine.jsonl", "old.jsonl", "codex.jsonl"}, indexedIDs(t, ss))
	counts, _ := ss.UnimportedCounts(ctx)
	require.Empty(t, counts)
}

// A current user loses nothing: a data directory that already lists chats records the choice as made.
func TestAnInstallThatAlreadyListsChatsKeepsListingThem(t *testing.T) {
	ctx, ss, fs, idx := importFixture(t)
	require.NoError(t, ss.ImportEarlierChats(ctx)) // the state of an install before this change: everything listed
	require.NoError(t, idx.RunOnce(ctx))
	require.Len(t, indexedIDs(t, ss), 3)

	// the same history, a data directory whose choice was never recorded but that has indexed rows
	_, err := ss.DB().ExecContext(ctx, `DELETE FROM user_settings WHERE key = 'history_import'`)
	require.NoError(t, err)
	fs.sessions[1].FileMtime += 10
	require.NoError(t, idx.RunOnce(ctx))
	require.Len(t, indexedIDs(t, ss), 3)
	on, err := ss.DecideHistoryImport(ctx)
	require.NoError(t, err)
	require.True(t, on)
}

// A chat that was listed stays listed when its agent is gone and the file changes.
func TestAChatThatWasListedStaysListedWhenItsAgentIsGone(t *testing.T) {
	ctx, ss, fs, idx := importFixture(t)
	require.NoError(t, idx.RunOnce(ctx))
	require.NoError(t, ss.UnregisterLiveSession(ctx, "mine"))
	fs.sessions[0].FileMtime += 5
	require.NoError(t, idx.RunOnce(ctx))
	require.ElementsMatch(t, []string{"mine.jsonl"}, indexedIDs(t, ss))
}
