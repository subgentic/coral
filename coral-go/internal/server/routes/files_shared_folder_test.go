package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
)

// #17673 (walk 77, item 3): two agents of a team share one folder. A file one of them wrote and has not committed is listed in the Files panel of the OTHER agent too (the list is the folder's
// uncommitted changes, not the agent's own tool calls), so a teammate that did nothing does not show "0 files changed" while the folder holds changes.
func TestFilesListsAFolderMatesUncommittedFile(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Post("/api/sessions/live/{name}/files/refresh", handler.RefreshFiles)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	ctx := context.Background()

	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		out, err := consoletest.HiddenCommand("git", append([]string{"-C", repo, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	git("init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "base.py"), []byte("print('base')\n"), 0o644))
	git("add", "-A")
	git("commit", "-q", "-m", "first")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "built_by_developer_2.py"), []byte("print('built')\n"), 0o644)) // written by the other agent, not committed

	reg := func(sid string) string {
		name := "claude-" + sid
		terminal.addSession(name, repo)
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))
		return name
	}
	idle := reg("00000000-0000-0000-0000-000000017673")
	reg("00000000-0000-0000-0000-000000027673") // the one that wrote it: it has a session of its own in the same folder

	_, err := handler.db.ExecContext(ctx, "INSERT INTO user_settings (key, value) VALUES ('git_diff_mode', 'uncommitted') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
	require.NoError(t, err)
	forgetRefreshResults()
	req, err := http.NewRequest(http.MethodPost, server.URL+"/api/sessions/live/"+idle+"/files/refresh", strings.NewReader(`{"session_id":"00000000-0000-0000-0000-000000017673"}`))
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var body struct {
		Files []struct {
			Filepath string `json:"filepath"`
		} `json:"files"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	var names []string
	for _, f := range body.Files {
		names = append(names, f.Filepath)
	}
	assert.Contains(t, names, "built_by_developer_2.py", "the idle agent's panel lists the folder's uncommitted file")
}
