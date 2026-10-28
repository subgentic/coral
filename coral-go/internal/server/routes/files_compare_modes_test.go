package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #10054 (desktop tester #10051): the Files panel said "vs HEAD~1" and listed only uncommitted changes; the last commit's file was missing. Every comparison the panel offers now lists what its
// words say, on a two-commit repository with an uncommitted change and an untracked file, and the answer names what it compares.
func TestFilesCompareModesListWhatTheirLabelsSay(t *testing.T) {
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
		out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	write := func(name, text string) {
		require.NoError(t, os.WriteFile(filepath.Join(repo, name), []byte(text), 0o644))
	}
	git("init", "-q", "-b", "main")
	write("base.py", "print('base')\n")
	git("add", "-A")
	git("commit", "-q", "-m", "first")
	write("todo.py", "# one\n# two\n# three\n") // the last commit's file: +3
	git("add", "-A")
	git("commit", "-q", "-m", "second")
	write("base.py", "print('base')\nprint('edited')\n") // uncommitted
	write("scratch.txt", "untracked\n")                  // untracked

	const sid = "00000000-0000-0000-0000-000000010054"
	name := "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))

	list := func(mode string) ([]string, map[string]any) {
		t.Helper()
		_, err := handler.db.ExecContext(ctx, "INSERT INTO user_settings (key, value) VALUES ('git_diff_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", mode)
		require.NoError(t, err)
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/sessions/live/"+name+"/files/refresh", strings.NewReader(`{"session_id":"`+sid+`"}`))
		require.NoError(t, err)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var body struct {
			Files []struct {
				Filepath  string `json:"filepath"`
				Additions int    `json:"additions"`
			} `json:"files"`
			Compare map[string]any `json:"compare"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		var names []string
		for _, f := range body.Files {
			names = append(names, f.Filepath)
		}
		sort.Strings(names)
		return names, body.Compare
	}
	label := func(c map[string]any) string { s, _ := c["label"].(string); return s }

	names, cmp := list("uncommitted")
	assert.Equal(t, []string{"base.py", "scratch.txt"}, names, "uncommitted changes: the edit and the new file, not the last commit's")
	assert.Equal(t, "Uncommitted changes", label(cmp))

	names, cmp = list("last_commit")
	assert.Equal(t, []string{"todo.py"}, names, "the last commit alone: HEAD~1..HEAD, no uncommitted change, no untracked file")
	assert.Equal(t, "Last commit", label(cmp))

	names, cmp = list("previous_commit")
	assert.Equal(t, []string{"base.py", "scratch.txt", "todo.py"}, names, "vs HEAD~1: the last commit and everything uncommitted")
	assert.Equal(t, "Last commit and uncommitted changes", label(cmp))

	names, cmp = list("branch_point")
	assert.Equal(t, []string{"base.py", "scratch.txt"}, names, "on main the branch point is HEAD: uncommitted changes")
	assert.Contains(t, label(cmp), "Uncommitted changes", "and the panel says so rather than 'merge-base'")

	// a branch with its own commit: the branch point is where it left main
	git("stash", "-q", "-u")
	git("checkout", "-q", "-b", "feature", "HEAD~1") // from the first commit: main's second commit is not on it
	write("feature.py", "x = 1\n")
	git("add", "-A")
	git("commit", "-q", "-m", "on the branch")
	write("base.py", "print('base')\nprint('wip')\n") // uncommitted on the branch
	names, cmp = list("branch_point")
	assert.Equal(t, []string{"base.py", "feature.py"}, names, "on a branch: what the branch added since main, plus its uncommitted work")
	assert.Equal(t, "Changes since the branch point", label(cmp))
	names, _ = list("last_commit")
	assert.Equal(t, []string{"feature.py"}, names)
	names, cmp = list("main_head")
	assert.Contains(t, names, "feature.py")
	assert.Equal(t, "Changes compared with main", label(cmp))
}
