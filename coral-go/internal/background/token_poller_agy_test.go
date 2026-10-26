package background

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

type agyRow struct {
	InputTokens     int    `db:"input_tokens"`
	OutputTokens    int    `db:"output_tokens"`
	CacheReadTokens int    `db:"cache_read_tokens"`
	AgentType       string `db:"agent_type"`
}

func agyUsage(t *testing.T, db *store.DB, sid string) []agyRow {
	t.Helper()
	var rows []agyRow
	require.NoError(t, db.SelectContext(context.Background(), &rows,
		"SELECT input_tokens, output_tokens, cache_read_tokens, agent_type FROM token_usage WHERE session_id = ? ORDER BY recorded_at, id", sid))
	return rows
}

// #7764: an agy session's tokens come from the PLANNER_RESPONSE rows of its transcript (real agy 1.4.7 capture), found by the conversation agy's own hook named for it:
// the transcript is keyed by agy's conversation id, and its first row carries no Coral marker. Only what is new is recorded on the next poll.
func TestPollAgySessionRecordsThePlannerResponseTokensOfItsLinkedConversation(t *testing.T) {
	db := setupTestDB(t)
	const sid = "00000000-0000-4000-8000-0000000000a7"
	const conv = "55555555-eeee-4eee-8eee-555555555555"
	home := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", home)
	t.Setenv("HOME", t.TempDir())
	dir := filepath.Join(home, "brain", conv, ".system_generated", "logs")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	fixture, err := os.ReadFile(filepath.Join("..", "jsonl", "testdata", "agy-1.4.7", "oneturn", "transcript.jsonl"))
	require.NoError(t, err)
	path := filepath.Join(dir, "transcript.jsonl")
	require.NoError(t, os.WriteFile(path, fixture, 0o600))

	ss, ls := registerForPoll(t, db, sid, "agy")
	poller := NewTokenPoller(ss, store.NewTokenUsageStore(db), time.Hour)
	poller.pollOnce(context.Background())
	assert.Empty(t, agyUsage(t, db, sid), "no hook link and no marker: the transcript is not guessed")

	require.NoError(t, transcriptlink.BindAgy(sid, conv))
	poller.pollOnce(context.Background()) // the poll loop's own dispatch by agent type
	rows := agyUsage(t, db, sid)
	require.Len(t, rows, 2, "the two model calls of the capture")
	assert.Equal(t, []int{6814, 63, 0}, []int{rows[0].InputTokens, rows[0].OutputTokens, rows[0].CacheReadTokens})
	assert.Equal(t, []int{2209, 52, 4760}, []int{rows[1].InputTokens, rows[1].OutputTokens, rows[1].CacheReadTokens})
	assert.Equal(t, "agy", rows[0].AgentType)

	// a later call is the only new row
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	require.NoError(t, err)
	_, err = f.WriteString(`{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-26T03:20:00Z","input_tokens":100,"cache_read_tokens":10,"output_tokens":5,"content":"ok"}` + "\n")
	require.NoError(t, err)
	require.NoError(t, f.Close())
	later := time.Now().Add(time.Minute)
	require.NoError(t, os.Chtimes(path, later, later))
	poller.pollAgySession(context.Background(), ls)
	rows = agyUsage(t, db, sid)
	require.Len(t, rows, 3)
	assert.Equal(t, []int{100, 5, 10}, []int{rows[2].InputTokens, rows[2].OutputTokens, rows[2].CacheReadTokens})
	poller.pollAgySession(context.Background(), ls)
	assert.Len(t, agyUsage(t, db, sid), 3, "nothing is recorded twice")
}
