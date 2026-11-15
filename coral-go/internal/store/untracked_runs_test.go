package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A job run whose agent never wrote a line has no chat row: Active now and All chats list it, with its state (#17447).
func TestAJobRunWithNoConversationIsListedAndCounted(t *testing.T) {
	s := NewSessionStore(openTestDB(t))
	ctx := context.Background()
	now := time.Now().UTC()
	at := now.Format("2006-01-02T15:04:05")
	old := now.Add(-10 * 24 * time.Hour).Format("2006-01-02T15:04:05")
	_, err := s.db.ExecContext(ctx, `INSERT INTO scheduled_jobs(id,name,cron_expr,repo_path,prompt,created_at,updated_at) VALUES (1,'nightly','* * * * *','/r','p',?,?)`, at, at)
	require.NoError(t, err)
	run := func(sid, status, when string) {
		t.Helper()
		_, err := s.db.ExecContext(ctx, `INSERT INTO scheduled_runs(job_id,session_id,status,scheduled_at,created_at) VALUES (1,?,?,?,?)`, sid, status, when, when)
		require.NoError(t, err)
	}
	run("starting", "running", at)
	run("failed", "failed", at)
	run("done", "completed", at)
	run("too-old", "failed", old)
	run("has-chat", "running", at)
	require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: "has-chat", SourceType: "claude", SourceFile: "/f", FirstTimestamp: &at, LastTimestamp: &at, MessageCount: 1}))

	runs, err := s.ListUntrackedRuns(ctx)
	require.NoError(t, err)
	got := map[string]bool{}
	for _, r := range runs {
		got[r.SessionID] = r.Starting()
	}
	assert.Equal(t, map[string]bool{"starting": true, "failed": false}, got, "a starting run and a failed one, not a finished run, an old one or one that has a chat")

	c, err := s.CountChatFolders(ctx, nil)
	require.NoError(t, err)
	assert.Equal(t, 3, c.All, "the two runs and the chat")
	assert.Equal(t, 1, c.Active, "only the starting run is active now")
}
