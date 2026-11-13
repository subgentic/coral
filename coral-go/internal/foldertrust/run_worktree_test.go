package foldertrust

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16421: a job's own run worktree, under Coral's hidden data folder, is trusted by a narrow function; Check is not loosened.

func runTree(t *testing.T) (home, root, dir string) {
	t.Helper()
	home = t.TempDir()
	root = filepath.Join(home, ".coral", "worktrees")
	dir = filepath.Join(root, "job-run-7-demo")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	return
}

func TestCheckStillRefusesTheHiddenWorktreeFolder(t *testing.T) {
	home, _, dir := runTree(t)
	for _, b := range []Basis{Existing, Ticked, Made} {
		_, err := Check(dir, home, b)
		assert.Error(t, err, "Check is unchanged: a folder under ~/.coral is never trusted by it (basis %d)", b)
	}
}

func TestCheckRunWorktreeTakesExactlyOneFolderInsideTheRoot(t *testing.T) {
	_, root, dir := runTree(t)
	got, err := CheckRunWorktree(dir, root)
	require.NoError(t, err)
	want, _ := filepath.EvalSymlinks(dir)
	assert.Equal(t, want, got)

	repo := t.TempDir()
	nested := filepath.Join(dir, "sub")
	require.NoError(t, os.MkdirAll(nested, 0o755))
	for name, p := range map[string]string{
		"the worktrees root":    root,
		"its parent":            filepath.Dir(root),
		"the repository":        repo,
		"a folder inside a run": nested,
		"a missing folder":      filepath.Join(root, "job-run-8-gone"),
		"a relative path":       "job-run-7-demo",
		"an empty path":         "",
	} {
		_, err := CheckRunWorktree(p, root)
		assert.Error(t, err, name)
	}
	_, err = CheckRunWorktree(dir, "")
	assert.Error(t, err, "no root")
}

func TestCheckRunWorktreeRefusesALinkAndAWritableFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("link and mode rules are POSIX")
	}
	_, root, _ := runTree(t)
	repo := t.TempDir()
	link := filepath.Join(root, "job-run-9-link")
	require.NoError(t, os.Symlink(repo, link))
	_, err := CheckRunWorktree(link, root)
	assert.Error(t, err, "a link to a folder outside the root")

	open := filepath.Join(root, "job-run-10-open")
	require.NoError(t, os.Mkdir(open, 0o755))
	require.NoError(t, os.Chmod(open, 0o777))
	_, err = CheckRunWorktree(open, root)
	assert.Error(t, err, "a folder others can write into")
}

func TestUntrustRemovesOnlyThatRunsEntry(t *testing.T) {
	_, root, dir := runTree(t)
	other := filepath.Join(root, "job-run-8-other")
	require.NoError(t, os.MkdirAll(other, 0o755))
	cfg := filepath.Join(t.TempDir(), ".claude.json")
	require.NoError(t, os.WriteFile(cfg, []byte(`{"numStartups": 3, "projects": {"/keep": {"hasTrustDialogAccepted": false}}}`), 0o600))
	for _, p := range []string{dir, other} {
		ok, err := TrustClaude(cfg, p)
		require.NoError(t, err)
		require.True(t, ok)
	}
	ok, err := UntrustClaude(cfg, dir)
	require.NoError(t, err)
	assert.True(t, ok)
	b, _ := os.ReadFile(cfg)
	assert.NotContains(t, string(b), "job-run-7-demo")
	assert.Contains(t, string(b), "job-run-8-other", "another run's entry stays")
	assert.Contains(t, string(b), `"/keep"`, "the person's own entry stays")
	assert.Contains(t, string(b), "numStartups")
	ok, err = UntrustClaude(cfg, dir)
	require.NoError(t, err)
	assert.False(t, ok, "a second removal finds nothing")

	toml := filepath.Join(t.TempDir(), "config.toml")
	require.NoError(t, os.WriteFile(toml, []byte("model = \"x\"\n\n[projects.\"/keep\"]\ntrust_level = \"untrusted\"\n"), 0o600))
	for _, p := range []string{dir, other} {
		ok, err := TrustCodex(toml, p)
		require.NoError(t, err)
		require.True(t, ok)
	}
	ok, err = UntrustCodex(toml, dir)
	require.NoError(t, err)
	assert.True(t, ok)
	tb, _ := os.ReadFile(toml)
	assert.False(t, strings.Contains(string(tb), "job-run-7-demo"))
	assert.Contains(t, string(tb), "job-run-8-other")
	assert.Contains(t, string(tb), "untrusted", "the person's own answer stays")
	assert.Contains(t, string(tb), `model = "x"`)
}
