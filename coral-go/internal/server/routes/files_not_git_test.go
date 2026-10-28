package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #6072: an agent in a folder that is not a git repository has nothing to compare. The changed-files list answers 200 with is_git false (the panel says "Not a git folder"), not the 400
// "Could not determine working directory" that showed as "0 files changed vs HEAD~1"; a folder that is a repository carries no is_git field.
func TestFilesInAFolderThatIsNotAGitRepositorySaysSo(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Get("/api/sessions/live/{name}/files", handler.Files)
	router.Post("/api/sessions/live/{name}/files/refresh", handler.RefreshFiles)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	ctx := context.Background()
	plain := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(plain, "notes.txt"), []byte("hi\n"), 0o644))

	const sid = "00000000-0000-0000-0000-0000000060f2"
	name := "claude-" + sid
	terminal.addSession(name, plain)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: plain}))

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/sessions/live/" + name + "/files?session_id=" + sid, ""},
		{http.MethodPost, "/api/sessions/live/" + name + "/files/refresh", `{"session_id":"` + sid + `"}`}, // a caller that is not the dashboard names its session (#7565)
	} {
		req, err := http.NewRequest(tc.method, server.URL+tc.path, strings.NewReader(tc.body))
		require.NoError(t, err)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		var body map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode, tc.method+" "+tc.path)
		assert.Equal(t, false, body["is_git"], tc.method+": is_git is false")
		files, _ := body["files"].([]any)
		require.Len(t, files, 1, tc.method+": the folder's one recent file is listed (#10256), not an empty list")
		assert.Equal(t, "notes.txt", files[0].(map[string]any)["filepath"], tc.method)
	}
}

// #10256: in a folder that is not a git repository the list is the folder's recently changed files, newest first, inside the bounds the file viewer has: nothing in a dot folder, no
// credential file, no symlink, nothing older than a week, at most 100 files; is_git stays false so the panel does not call them changes.
func TestFilesInAPlainFolderListTheRecentFilesNewestFirst(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Get("/api/sessions/live/{name}/files", handler.Files)
	router.Get("/api/sessions/live/{name}/file-content", handler.GetFileContent)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	ctx := context.Background()
	plain := t.TempDir()
	now := time.Now()
	write := func(rel string, age time.Duration) {
		p := filepath.Join(plain, filepath.FromSlash(rel))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte("x\n"), 0o644))
		require.NoError(t, os.Chtimes(p, now.Add(-age), now.Add(-age)))
	}
	write("report.md", time.Hour)
	write("out/data.csv", time.Minute)
	write("old.txt", 30*24*time.Hour)
	write(".hidden/secret.txt", time.Minute)
	write(".env", time.Minute)
	write("node/.cache/x.txt", time.Minute)
	if err := os.Symlink(filepath.Join(plain, "report.md"), filepath.Join(plain, "link.md")); err != nil {
		t.Logf("no symlinks here: %v", err)
	}

	const sid = "00000000-0000-0000-0000-000000010256"
	name := "claude-" + sid
	terminal.addSession(name, plain)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: plain}))

	resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/files?session_id=" + sid)
	require.NoError(t, err)
	var body struct {
		IsGit *bool `json:"is_git"`
		Files []struct {
			Filepath   string `json:"filepath"`
			RecordedAt string `json:"recorded_at"`
		} `json:"files"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	resp.Body.Close()
	require.NotNil(t, body.IsGit)
	assert.False(t, *body.IsGit)
	var got []string
	for _, f := range body.Files {
		got = append(got, f.Filepath)
		assert.NotEmpty(t, f.RecordedAt, f.Filepath+" says when it changed")
	}
	assert.Equal(t, []string{"out/data.csv", "report.md"}, got, "newest first; no dot folder, credential file, symlink or file older than a week")
	// and each listed file opens: the viewer serves it
	for _, f := range got {
		r2, err := http.Get(server.URL + "/api/sessions/live/" + name + "/file-content?session_id=" + sid + "&filepath=" + url.QueryEscape(f))
		require.NoError(t, err)
		r2.Body.Close()
		assert.Equal(t, http.StatusOK, r2.StatusCode, f+" opens")
	}
}

// The list is bounded: 100 files at most, the newest.
func TestRecentFilesInAPlainFolderAreBounded(t *testing.T) {
	plain := t.TempDir()
	now := time.Now()
	for i := 0; i < 130; i++ {
		p := filepath.Join(plain, "f"+strconv.Itoa(i)+".txt")
		require.NoError(t, os.WriteFile(p, []byte("x"), 0o644))
		require.NoError(t, os.Chtimes(p, now.Add(-time.Duration(i)*time.Minute), now.Add(-time.Duration(i)*time.Minute)))
	}
	files := recentFilesInPlainFolder(plain, false)
	require.Len(t, files, 100)
	assert.Equal(t, "f0.txt", files[0].Filepath)
	assert.Equal(t, "f99.txt", files[99].Filepath)
}
