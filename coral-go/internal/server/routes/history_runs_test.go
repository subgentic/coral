package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The chat list holds a job run whose agent never wrote a line, with its state (#17447).
func TestAJobRunWithNoConversationIsAChatRow(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "runs.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewHistoryHandler(db, &config.Config{}, nil)
	at := time.Now().UTC().Format("2006-01-02T15:04:05")
	require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "chat", SourceType: "claude", SourceFile: "/f", LastTimestamp: &at}))
	_, err = db.ExecContext(ctx, `INSERT INTO scheduled_jobs(id,name,cron_expr,repo_path,prompt,created_at,updated_at) VALUES (1,'nightly','* * * * *','/r','p',?,?)`, at, at)
	require.NoError(t, err)
	for _, r := range [][2]string{{"run-a", "running"}, {"run-b", "failed"}} {
		_, err = db.ExecContext(ctx, `INSERT INTO scheduled_runs(job_id,session_id,status,scheduled_at,created_at) VALUES (1,?,?,?,?)`, r[0], r[1], at, at)
		require.NoError(t, err)
	}
	list := func(query string) (int, map[string]string) {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ListSessions(rec, httptest.NewRequest("GET", "/api/sessions/history?"+query, nil))
		var out struct {
			Total    int              `json:"total"`
			Sessions []map[string]any `json:"sessions"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		states := map[string]string{}
		for _, s := range out.Sessions {
			st, _ := s["run_state"].(string)
			states[s["session_id"].(string)] = st
		}
		return out.Total, states
	}
	total, got := list("type=agent")
	assert.Equal(t, 3, total)
	assert.Equal(t, map[string]string{"chat": "", "run-a": "Starting", "run-b": "Did not start"}, got)
	total, got = list("type=agent&active=1")
	assert.Equal(t, 1, total, "only the run that may still start is active now")
	assert.Equal(t, map[string]string{"run-a": "Starting"}, got)
	_, got = list("type=agent&starred=1")
	assert.Empty(t, got, "a run is never starred")
}
