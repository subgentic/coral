package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9359: the facts of a session are kept for ten minutes once complete: the same answer as reading them, no query for a kept session, and a session that has recorded nothing yet is asked for again.
func TestSessionFactsAreKeptOnceComplete(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	ts := NewTokenUsageStore(db)
	ss := NewSessionStore(db)
	clock := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	ss.facts.now = func() time.Time { return clock }
	started := clock.Add(-3 * time.Hour).Truncate(time.Second)
	require.NoError(t, ts.RecordUsage(ctx, &TokenUsage{SessionID: "known", AgentName: "k", AgentType: "codex", InputTokens: 1, TotalTokens: 1, Source: "jsonl",
		SessionStartAt: started.Format(ISOFormat), RecordedAt: clock.Add(-2 * time.Hour).Format(ISOFormat)}))

	// a session with half of its facts: a transcript index row with a first message and no source type (a start, no provider)
	_, err := db.ExecContext(ctx, `INSERT INTO session_index(session_id, source_type, source_file, first_timestamp, last_timestamp, indexed_at, file_mtime) VALUES ('half', '', '/f', ?, ?, ?, 0)`,
		started.Format(ISOFormat), started.Format(ISOFormat), started.Format(ISOFormat))
	require.NoError(t, err)

	first, err := ss.SessionFacts(ctx, []string{"known", "later", "half"})
	require.NoError(t, err)
	assert.True(t, first["known"].Start.Equal(started))
	assert.Equal(t, "codex", first["known"].Provider)
	assert.True(t, first["later"].Start.IsZero(), "nothing recorded yet")
	assert.True(t, first["half"].Start.Equal(started), "a start")
	assert.Equal(t, "", first["half"].Provider, "and no provider")

	// a kept session is not read again (its usage rows can go and the answer stays); one that had nothing is read again and finds what has come in
	_, err = db.ExecContext(ctx, `DELETE FROM token_usage WHERE session_id = 'known'`)
	require.NoError(t, err)
	require.NoError(t, ts.RecordUsage(ctx, &TokenUsage{SessionID: "later", AgentName: "l", AgentType: "claude", InputTokens: 1, TotalTokens: 1, Source: "jsonl",
		SessionStartAt: started.Format(ISOFormat), RecordedAt: clock.Add(-time.Hour).Format(ISOFormat)}))
	require.NoError(t, ts.RecordUsage(ctx, &TokenUsage{SessionID: "half", AgentName: "h", AgentType: "pi", InputTokens: 1, TotalTokens: 1, Source: "jsonl",
		SessionStartAt: started.Format(ISOFormat), RecordedAt: clock.Add(-time.Hour).Format(ISOFormat)}))
	second, err := ss.SessionFacts(ctx, []string{"known", "later", "half"})
	require.NoError(t, err)
	assert.Equal(t, first["known"], second["known"], "kept")
	assert.Equal(t, "claude", second["later"].Provider, "a session with no facts the first time is asked for again")
	assert.Equal(t, "pi", second["half"].Provider, "half of the facts is not kept: the session is asked for again and comes back whole")

	// ten minutes on, a kept session is read again
	clock = clock.Add(sessionFactsFresh + time.Second)
	third, err := ss.SessionFacts(ctx, []string{"known"})
	require.NoError(t, err)
	assert.True(t, third["known"].Start.IsZero(), "the facts were only as fresh as the ten minutes")
}

// The same facts as the unkept read at the size of the Analytics reads (5,000 sessions of 20 usage rows), and the second read of them is a lookup: far inside the 115 ms the first one took.
func TestSessionFactsAtScale(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	const sessions, per = 5000, 20
	_, err := db.ExecContext(ctx, fmt.Sprintf(`WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM s WHERE n < %d), r(k) AS (SELECT 0 UNION ALL SELECT k+1 FROM r WHERE k < %d)
		INSERT INTO token_usage(session_id, agent_name, agent_type, board_name, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, recorded_at, session_start_at, model)
		SELECT 'sess-' || s.n, 'agent', CASE s.n %% 3 WHEN 0 THEN 'claude' WHEN 1 THEN 'codex' ELSE 'pi' END, 'team', 100, 50, 150, 0.01, 1,
		       strftime('%%Y-%%m-%%dT%%H:%%M:%%f', '2026-10-01 00:00:00', '+' || (s.n*7 + r.k) || ' seconds'), '2026-10-01T00:00:00Z', 'm' FROM s, r`, sessions-1, per-1))
	require.NoError(t, err)
	ids := make([]string, sessions)
	for i := range ids {
		ids[i] = fmt.Sprintf("sess-%d", i)
	}
	ss := NewSessionStore(db)
	first, err := ss.SessionFacts(ctx, ids)
	require.NoError(t, err)
	require.Len(t, first, sessions)
	assert.Equal(t, "claude", first["sess-0"].Provider)
	assert.Equal(t, "codex", first["sess-1"].Provider)
	assert.Equal(t, "pi", first["sess-2"].Provider)
	start := time.Now()
	second, err := ss.SessionFacts(ctx, ids)
	took := time.Since(start)
	require.NoError(t, err)
	assert.Equal(t, first, second, "the kept facts are the read ones")
	assert.Less(t, took, 50*time.Millisecond, "a kept read is a lookup (a generous budget)")
}
