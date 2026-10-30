package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
)

// The Files panel opens a file with the path its own list gave (#11284 item 2, the phone check's 'File not found' for an HTML file): every file the changed-files list and the explorer
// return must be read by file-content under that same path, whatever the agent's folder is: a plain folder, a folder inside a repository, a git worktree or a folder of it, and a name
// with a space, a #, a % or non-ASCII letters (the panel sends the path as a query value). Before this the report could not be told from a mock whose list names a file that is not on disk.
func TestEveryFileTheFilesPanelListsOpensUnderItsOwnPath(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Get("/api/sessions/live/{name}/files", handler.Files)
	router.Get("/api/sessions/live/{name}/search-files", handler.SearchFiles)
	router.Get("/api/sessions/live/{name}/file-content", handler.GetFileContent)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	ctx := context.Background()

	git := func(dir string, args ...string) {
		c := consoletest.HiddenCommand("git", append([]string{"-c", "user.email=a@b.c", "-c", "user.name=n"}, args...)...)
		c.Dir = dir
		out, err := c.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	names := []string{"preview.html", "my preview #1 100%.html", "résumé & notes.html"}
	if runtime.GOOS != "windows" {
		names = append(names, `say "hi".html`, `back\slash.html`) // git still quotes these (a quote, a backslash) even with core.quotePath off
	}
	write := func(dir string) {
		require.NoError(t, os.MkdirAll(dir, 0o755))
		for _, n := range names {
			require.NoError(t, os.WriteFile(filepath.Join(dir, n), []byte("<h1>"+n+"</h1>"), 0o644))
		}
	}
	plain := t.TempDir()
	write(plain)
	repo := t.TempDir()
	git(repo, "init", "-q")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "README"), []byte("x"), 0o644))
	git(repo, "add", "README")
	git(repo, "commit", "-qm", "c")
	write(filepath.Join(repo, "app"))
	wt := filepath.Join(t.TempDir(), "wt")
	git(repo, "worktree", "add", "-q", "-b", "feat", wt)
	write(filepath.Join(wt, "sub"))
	write(wt)

	get := func(path string) (int, map[string]any) {
		resp, err := http.Get(server.URL + path)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	i := 0
	for label, dir := range map[string]string{"plain folder": plain, "a folder inside a repository": filepath.Join(repo, "app"), "a worktree": wt, "a folder of a worktree": filepath.Join(wt, "sub")} {
		i++
		sid := "00000000-0000-0000-0000-00000011284" + string(rune('0'+i))
		name := "claude-" + sid
		terminal.addSession(name, dir)
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: dir}))
		base := "/api/sessions/live/" + name

		var listed []string
		_, changed := get(base + "/files?session_id=" + sid)
		fs, _ := changed["files"].([]any)
		for _, f := range fs {
			listed = append(listed, f.(map[string]any)["filepath"].(string))
		}
		_, explorer := get(base + "/search-files?" + url.Values{"session_id": {sid}, "dir": {"."}, "view": {"explorer"}}.Encode())
		es, _ := explorer["entries"].([]any)
		for _, e := range es {
			if m := e.(map[string]any); m["type"] == "file" {
				listed = append(listed, m["path"].(string))
			}
		}
		require.NotEmpty(t, listed, label+": the panel lists files")
		var html int
		for _, fp := range listed {
			code, out := get(base + "/file-content?" + url.Values{"session_id": {sid}, "filepath": {fp}}.Encode())
			assert.Equal(t, http.StatusOK, code, "%s: %q is listed, so it opens (%v)", label, fp, out["error"])
			if filepath.Ext(fp) == ".html" {
				html++
			}
		}
		assert.NotZero(t, html, label+": an HTML file is among them")
	}
}
