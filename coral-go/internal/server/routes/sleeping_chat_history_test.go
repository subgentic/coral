package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// "I should be able to scroll through the chat history of sleeping/ended agents": the chat route answers a sleeping or ended agent's history from its own transcript file, without a terminal, a running CLI or
// any metadata in the request but its name, as the page asks.
func TestSleepingAndEndedAgentsChatHistoryIsServed(t *testing.T) {
	for _, reason := range []string{"", store.SleepReasonAgentExited, "terminal_gone"} {
		t.Run("sleep_reason="+reason, func(t *testing.T) {
			_, handler, _, ss := setupSessionsTestServer(t)
			projects := t.TempDir()
			t.Setenv("CLAUDE_PROJECTS_DIR", projects)
			sid := "22222222-0000-4000-8000-000000000001"
			wd := t.TempDir()
			real, err := filepath.EvalSymlinks(wd)
			require.NoError(t, err)
			dir := filepath.Join(projects, transcriptlink.ClaudeProjectDirName(real))
			require.NoError(t, os.MkdirAll(dir, 0o755))
			var lines string
			for i := 0; i < 30; i++ {
				lines += fmt.Sprintf(`{"type":"user","timestamp":"2026-10-29T10:%02d:00.000Z","message":{"content":"question %d"}}`+"\n"+
					`{"type":"assistant","timestamp":"2026-10-29T10:%02d:05.000Z","message":{"content":[{"type":"text","text":"answer %d"}]}}`+"\n", i, i, i, i)
			}
			require.NoError(t, os.WriteFile(filepath.Join(dir, sid+".jsonl"), []byte(lines), 0o644))
			ls := &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "GDeveloper", WorkingDir: real, IsSleeping: 1}
			if reason != "" {
				ls.SleepReason = &reason
			}
			require.NoError(t, ss.RegisterLiveSession(context.Background(), ls))

			r := chi.NewRouter()
			r.Get("/api/sessions/live/{name}/chat", handler.Chat)
			// the page's first request for a session it knows by name and id
			for _, q := range []string{"?after=0&limit=20&session_id=" + sid + "&agent_type=claude"} {
				rec := httptest.NewRecorder()
				r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live/"+"claude-"+sid+"/chat"+q, nil))
				require.Equal(t, http.StatusOK, rec.Code, q)
				var got struct {
					Messages []map[string]any `json:"messages"`
					Total    int              `json:"total"`
					HasMore  bool             `json:"has_more"`
				}
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
				assert.Equal(t, 60, got.Total, "the whole history is counted: %s", q)
				assert.Len(t, got.Messages, 20, q)
				assert.True(t, got.HasMore, "and earlier pages are there: %s", q)
			}
		})
	}
}

// The operator's agent: a resumed session (resume_from_id set) whose transcript files are both gone from disk answers an empty first page, not an error, so the page can say what the agent is.
func TestAResumedSleepingAgentWithNoTranscriptOnDiskAnswersAnEmptyPage(t *testing.T) {
	_, handler, _, ss := setupSessionsTestServer(t)
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	sid, from := "22222222-0000-4000-8000-000000000002", "22222222-0000-4000-8000-000000000003"
	reason := store.SleepReasonAgentExited
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Go Backend Developer", WorkingDir: t.TempDir(), IsSleeping: 1, SleepReason: &reason, ResumeFromID: &from}))
	r := chi.NewRouter()
	r.Get("/api/sessions/live/{name}/chat", handler.Chat)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live/Go%20Backend%20Developer/chat?session_id="+sid+"&agent_type=claude&after=0&limit=20&offset=0&trim=1", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got struct {
		Messages []map[string]any `json:"messages"`
		Total    int              `json:"total"`
		HasMore  bool             `json:"has_more"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Zero(t, got.Total)
	assert.Empty(t, got.Messages)
	assert.False(t, got.HasMore)
}
