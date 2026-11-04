package store

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13155: the events of one session are read through the session's own index, even before SQLite has statistics (it used the agent's index and read all the agent's events), and the rows are the same.
func TestTheEventsOfASessionAreReadThroughTheSessionIndexWithoutStatistics(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	for a := 0; a < 3; a++ {
		for s := 0; s < 4; s++ {
			for e := 0; e < 30; e++ {
				_, err := db.ExecContext(ctx, `INSERT INTO agent_events (agent_name, session_id, event_type, tool_name, summary, created_at) VALUES (?, ?, 'tool_use', 'Bash', 'ls', ?)`,
					"agent-"+string(rune('a'+a)), "sess-"+string(rune('a'+a))+string(rune('0'+s)), "2026-10-01T00:00:"+string(rune('0'+e/10))+string(rune('0'+e%10))+".000000+00:00")
				require.NoError(t, err)
			}
		}
	}
	var plan []string
	rows, err := db.QueryxContext(ctx, `EXPLAIN QUERY PLAN `+listAgentEventsSQL(true, true), "agent-b", "sess-b2", 5)
	require.NoError(t, err)
	for rows.Next() {
		var a, b, c int
		var d string
		require.NoError(t, rows.Scan(&a, &b, &c, &d))
		plan = append(plan, d)
	}
	rows.Close()
	assert.Contains(t, strings.Join(plan, "; "), "idx_agent_events_session_time", "the plan of the poll's query")
	assert.NotContains(t, strings.Join(plan, "; "), "idx_agent_events_agent")

	ts := NewTaskStore(db)
	sess := "sess-b2"
	ev, err := ts.ListAgentEvents(ctx, "agent-b", 5, &sess)
	require.NoError(t, err)
	require.Len(t, ev, 5)
	assert.Equal(t, "2026-10-01T00:00:29.000000+00:00", ev[0].CreatedAt)
	other, err := ts.ListAgentEvents(ctx, "agent-a", 5, &sess)
	require.NoError(t, err)
	assert.Empty(t, other, "the agent's name is still a filter")
	all, err := ts.ListAgentEvents(ctx, "", 5, &sess)
	require.NoError(t, err)
	assert.Len(t, all, 5, "by session alone, as the worktree follow reads it")
}
