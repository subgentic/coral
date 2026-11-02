package routes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The live changes view lists an untracked folder as one entry, as `git status` and the changed-files list do (#12524): a sync tool's trace folder is `?? .git.sync.traces/`, not one entry per file in it.
// An untracked file beside it, and one inside a folder that is tracked, are still shown whole; the tracked change is unchanged; an ignored folder is not there at all.
func TestLiveChangesShowAnUntrackedFolderAsOneEntry(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := diffRepo(t)
	write := func(rel, body string) {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(repo, rel)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(repo, rel), []byte(body), 0o644))
	}
	write("main.go", "package main\n\nfunc main() {}\n")
	write("notes.md", "a plain new file\n")
	write(".git.sync.traces/a/1.json", "{\"trace\": 1}\n")
	write(".git.sync.traces/2.json", "{\"trace\": 2}\n")
	write("scratch/x.txt", "one\n")
	write("scratch/y.txt", "two\n")
	write(".gitignore", "ignored/\n")
	write("ignored/z.txt", "never\n")

	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	got := string(out)
	assert.Contains(t, got, "+func main() {}", "the tracked change is unchanged")
	assert.Contains(t, got, "+a plain new file", "an untracked file is still shown whole")
	assert.NotContains(t, got, "1.json", "a file inside an untracked folder is not an entry of its own")
	assert.NotContains(t, got, "2.json")
	assert.NotContains(t, got, `{"trace"`)
	assert.Equal(t, 1, strings.Count(got, `new folder ".git.sync.traces/"`), "the folder is one entry, once: %s", got)
	assert.Equal(t, 1, strings.Count(got, `new folder "scratch/"`), "any untracked folder is one entry, not only a dot-folder")
	assert.NotContains(t, got, "x.txt")
	assert.NotContains(t, got, `folder "ignored/"`, "an ignored folder is not listed (every ignore rule still holds)")
	assert.NotContains(t, got, "z.txt")
}

// A folder that has a tracked file shows its untracked files one by one, as git status does.
func TestLiveChangesKeepUntrackedFilesInATrackedFolderWhole(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := diffRepo(t)
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "pkg"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "pkg", "a.go"), []byte("package pkg\n"), 0o644))
	for _, args := range [][]string{{"add", "."}, {"commit", "-q", "-m", "pkg"}} {
		gitIn(t, repo, args...)
	}
	require.NoError(t, os.WriteFile(filepath.Join(repo, "pkg", "b.go"), []byte("package pkg // new\n"), 0o644))
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	assert.Contains(t, string(out), "+package pkg // new")
	assert.NotContains(t, string(out), `new folder "pkg/"`)
}

// Every git ignore rule hides a folder from the view: .gitignore, .git/info/exclude and core.excludesFile (#12524).
func TestLiveChangesHonourEveryIgnoreSource(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := diffRepo(t)
	write := func(path, body string) {
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(t, os.WriteFile(path, []byte(body), 0o644))
	}
	global := filepath.Join(t.TempDir(), "global-ignore")
	write(global, "from-global/\n")
	gitIn(t, repo, "config", "core.excludesFile", global)
	write(filepath.Join(repo, ".git", "info", "exclude"), "from-exclude/\n")
	write(filepath.Join(repo, ".gitignore"), "from-gitignore/\n")
	for _, d := range []string{"from-global", "from-exclude", "from-gitignore", "shown"} {
		write(filepath.Join(repo, d, "f.txt"), "x\n")
	}
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	got := string(out)
	assert.Contains(t, got, `new folder "shown/"`)
	for _, d := range []string{"from-global", "from-exclude", "from-gitignore"} {
		assert.NotContains(t, got, `folder "`+d+`/"`, d) // .gitignore's own text names the folder, so the entry is what is checked
		assert.NotContains(t, got, d+"/f.txt", d)
	}
}
