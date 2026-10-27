package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8915: each usage row keeps the thinking level its call ran at, from now on: what the transcript recorded for the call, else the level the session was set to when a live call is recorded; an old call
// (a first read of a transcript) and a session with no level keep nothing (NULL, "Not recorded"), never a guess.
func TestUsageRowsKeepTheThinkingLevelOfTheirCall(t *testing.T) {
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	lvl := "Medium "
	require.NoError(t, NewSessionStore(db).RegisterLiveSession(ctx, &LiveSession{SessionID: "sess-a", AgentName: "a", AgentType: "claude", WorkingDir: "/w", Thinking: &lvl}))
	require.NoError(t, NewSessionStore(db).RegisterLiveSession(ctx, &LiveSession{SessionID: "sess-b", AgentName: "b", AgentType: "claude", WorkingDir: "/w"}))
	now := time.Now().UTC()
	rec := func(sid, at, thinking string) {
		require.NoError(t, s.RecordUsage(ctx, &TokenUsage{SessionID: sid, AgentName: sid, AgentType: "claude", InputTokens: 10, TotalTokens: 10, RecordedAt: at, Source: "jsonl", Thinking: thinking}))
	}
	rec("sess-a", now.Add(-3*time.Second).Format(ISOFormat), "")       // live, no level in the call: the session's
	rec("sess-a", now.Add(-2*time.Second).Format(ISOFormat), " HIGH ") // the call's own level wins, lower-cased
	rec("sess-a", now.Add(-72*time.Hour).Format(ISOFormat), "")        // an old call: nothing, not the session's level of today
	rec("sess-b", now.Add(-time.Second).Format(ISOFormat), "")         // a session with no level: nothing
	rec("sess-unknown", now.Add(-4*time.Second).Format(ISOFormat), "") // no such live session: nothing
	rows, err := db.QueryxContext(ctx, `SELECT session_id, recorded_at, thinking FROM token_usage ORDER BY recorded_at`)
	require.NoError(t, err)
	defer rows.Close()
	var seq []string
	for rows.Next() {
		var sid, at string
		var th *string
		require.NoError(t, rows.Scan(&sid, &at, &th))
		v := "NULL"
		if th != nil {
			v = *th
		}
		seq = append(seq, sid+"="+v)
	}
	// by call, oldest first
	assert.Equal(t, "sess-a=NULL", seq[0], "the old call keeps nothing")
	assert.Equal(t, "sess-unknown=NULL", seq[1], "no live session, nothing")
	assert.Equal(t, "sess-a=medium", seq[2], "a live call takes the session's level, trimmed and lower-cased")
	assert.Equal(t, "sess-a=high", seq[3], "the call's own level wins")
	assert.Equal(t, "sess-b=NULL", seq[4], "a session with no level, nothing")
}

// The level survives the retention rollup: rows of one hour at different levels stay two hourly rows, and token_usage_all carries the level for raw and rolled-up rows alike.
func TestTheThinkingLevelSurvivesTheRollup(t *testing.T) {
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	old := time.Now().UTC().Add(-90 * 24 * time.Hour).Truncate(time.Hour)
	for i, th := range []string{"low", "low", "high", ""} {
		require.NoError(t, s.RecordUsage(ctx, &TokenUsage{SessionID: "sess-r", AgentName: "r", AgentType: "claude", InputTokens: 5, TotalTokens: 5, Source: "jsonl", Thinking: th,
			RecordedAt: old.Add(time.Duration(i+1) * time.Minute).Format(ISOFormat)}))
	}
	_, rolled, err := db.RollupTokenUsage(ctx, time.Now().UTC().Add(-48*time.Hour), 1000)
	require.NoError(t, err)
	require.EqualValues(t, 4, rolled)
	type row struct {
		Thinking *string `db:"thinking"`
		NRows    int     `db:"n_rows"`
		Tokens   int     `db:"total_tokens"`
	}
	var got []row
	require.NoError(t, db.SelectContext(ctx, &got, `SELECT thinking, n_rows, total_tokens FROM token_usage_all ORDER BY COALESCE(thinking, '')`))
	require.Len(t, got, 3, "three levels in the hour: three hourly rows")
	assert.Nil(t, got[0].Thinking)
	assert.Equal(t, 1, got[0].NRows)
	require.NotNil(t, got[1].Thinking)
	assert.Equal(t, "high", *got[1].Thinking)
	require.NotNil(t, got[2].Thinking)
	assert.Equal(t, "low", *got[2].Thinking)
	assert.Equal(t, 2, got[2].NRows)
	assert.Equal(t, 10, got[2].Tokens)
}

// A database from before the level was kept (no thinking column on the usage rows or the hourly rows, a view without it) opens, keeps every row, and shows them as not recorded; new rows then keep the level.
func TestAnOlderDatabaseGainsTheThinkingColumn(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	require.NoError(t, os.WriteFile(path, migratedTemplate(t), 0o644))
	db, err := OpenWithKey(ctx, path, "")
	require.NoError(t, err)
	s := NewTokenUsageStore(db)
	require.NoError(t, s.RecordUsage(ctx, &TokenUsage{SessionID: "old-s", AgentName: "o", AgentType: "claude", InputTokens: 7, TotalTokens: 7, Source: "jsonl", RecordedAt: time.Now().UTC().Add(-time.Hour).Format(ISOFormat)}))
	// what a database of before has: the view, the hourly table and the usage table without the column
	// (SQLite will not drop a column a view or trigger names: both are made again on every start, so they go first)
	var triggers []string
	require.NoError(t, db.SelectContext(ctx, &triggers, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND (sql LIKE '%token_usage_all%' OR sql LIKE '%token_usage_hourly%')`))
	for _, name := range triggers {
		_, err := db.ExecContext(ctx, `DROP TRIGGER `+name)
		require.NoError(t, err, name)
	}
	for _, q := range []string{`DROP VIEW token_usage_all`, `ALTER TABLE token_usage_hourly DROP COLUMN thinking`, `ALTER TABLE token_usage DROP COLUMN thinking`} {
		_, err := db.ExecContext(ctx, q)
		require.NoError(t, err, q)
	}
	require.NoError(t, db.Close())

	db, err = OpenWithKey(ctx, path, "")
	require.NoError(t, err)
	defer db.Close()
	var n, notRecorded int
	require.NoError(t, db.GetContext(ctx, &n, `SELECT COUNT(*) FROM token_usage_all`))
	require.NoError(t, db.GetContext(ctx, &notRecorded, `SELECT COUNT(*) FROM token_usage_all WHERE thinking IS NULL`))
	assert.Equal(t, 1, n, "the row is kept")
	assert.Equal(t, 1, notRecorded, "and is not recorded")
	require.NoError(t, NewTokenUsageStore(db).RecordUsage(ctx, &TokenUsage{SessionID: "new-s", AgentName: "n", AgentType: "claude", InputTokens: 3, TotalTokens: 3, Source: "jsonl", Thinking: "low"}))
	var low int
	require.NoError(t, db.GetContext(ctx, &low, `SELECT COUNT(*) FROM token_usage_all WHERE thinking = 'low'`))
	assert.Equal(t, 1, low)
}
