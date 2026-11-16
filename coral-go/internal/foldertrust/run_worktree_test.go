package foldertrust

import (
	"fmt"
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

// #17396: git keeps a worktree with unsaved work and a folder can be removed by hand, so a run's entry can outlive its folder; a sweep takes only those, for Claude and Codex, and nothing else.
func TestSweepRemovesTheEntriesOfGoneRunFoldersOnly(t *testing.T) {
	_, root, live := runTree(t)
	gone := filepath.Join(root, "job-run-9-gone")
	require.NoError(t, os.MkdirAll(gone, 0o755))
	cfg := filepath.Join(t.TempDir(), ".claude.json")
	require.NoError(t, os.WriteFile(cfg, []byte(`{"numStartups": 3, "projects": {"/keep/me": {"hasTrustDialogAccepted": true}}}`), 0o600))
	toml := filepath.Join(t.TempDir(), "config.toml")
	require.NoError(t, os.WriteFile(toml, []byte("model = \"x\"\n\n[projects.\"/keep/me\"]\ntrust_level = \"untrusted\"\n"), 0o600))
	for _, p := range []string{live, gone} {
		ok, err := TrustClaude(cfg, p)
		require.NoError(t, err)
		require.True(t, ok)
		ok, err = TrustCodex(toml, p)
		require.NoError(t, err)
		require.True(t, ok)
	}
	elsewhere := filepath.Join(t.TempDir(), "job-run-5-elsewhere") // a folder that is gone but is not in the worktrees folder: not Coral's to take
	ok, err := TrustClaude(cfg, elsewhere)
	require.NoError(t, err)
	require.True(t, ok)
	require.NoError(t, os.RemoveAll(gone))

	n, err := SweepGoneRunFolders(cfg, toml, root)
	require.NoError(t, err)
	assert.Equal(t, 2, n, "the gone run's entry in each file")
	c, _ := os.ReadFile(cfg)
	assert.NotContains(t, string(c), "job-run-9-gone")
	assert.Contains(t, string(c), "job-run-7-demo", "a folder that is still there keeps its entry")
	assert.Contains(t, string(c), "job-run-5-elsewhere", "an entry outside the worktrees folder is left")
	assert.Contains(t, string(c), "/keep/me")
	tb, _ := os.ReadFile(toml)
	assert.NotContains(t, string(tb), "job-run-9-gone")
	assert.Contains(t, string(tb), "job-run-7-demo")
	assert.Contains(t, string(tb), "/keep/me")

	n, err = SweepGoneRunFolders(cfg, toml, root)
	require.NoError(t, err)
	assert.Zero(t, n, "a second sweep finds nothing")
	n, err = SweepGoneRunFolders(filepath.Join(t.TempDir(), "none.json"), filepath.Join(t.TempDir(), "none.toml"), root)
	require.NoError(t, err)
	assert.Zero(t, n, "no settings files is not an error")
}

// #18032: many gone entries cost one write per settings file, not one per entry (live agents write these files too); and a worktrees root that is not there (an unmounted volume) takes nothing.
func TestSweepWritesEachSettingsFileOnceAndSkipsAMissingRoot(t *testing.T) {
	_, root, _ := runTree(t)
	cfg := filepath.Join(t.TempDir(), ".claude.json")
	toml := filepath.Join(t.TempDir(), "config.toml")
	var cj strings.Builder
	cj.WriteString(`{"projects": {"/keep/me": {"x": 1}`)
	var tb strings.Builder
	tb.WriteString("[projects.\"/keep/me\"]\ntrust_level = \"trusted\"\n\n")
	for i := 0; i < 5; i++ {
		p := filepath.Join(root, fmt.Sprintf("job-run-%d-gone", 100+i))
		cj.WriteString(fmt.Sprintf(`, %q: {"hasTrustDialogAccepted": true}`, p))
		tb.WriteString(fmt.Sprintf("[projects.%s]\ntrust_level = \"trusted\"\n\n", tomlKey(t, p)))
	}
	cj.WriteString("}}")
	require.NoError(t, os.WriteFile(cfg, []byte(cj.String()), 0o600))
	require.NoError(t, os.WriteFile(toml, []byte(tb.String()), 0o600))

	// the root is not there (an unmounted volume), though the keys name folders in it: every key looks gone, and nothing is taken
	require.NoError(t, os.Rename(root, root+".away"))
	n, err := SweepGoneRunFolders(cfg, toml, root)
	require.NoError(t, err)
	assert.Zero(t, n)
	c, _ := os.ReadFile(cfg)
	assert.Equal(t, cj.String(), string(c))
	tb0, _ := os.ReadFile(toml)
	assert.Equal(t, tb.String(), string(tb0))
	require.NoError(t, os.Rename(root+".away", root))

	var writes []string
	orig := writeSettings
	writeSettings = func(path string, data []byte, mode os.FileMode) error {
		writes = append(writes, path)
		return orig(path, data, mode)
	}
	t.Cleanup(func() { writeSettings = orig })
	n, err = SweepGoneRunFolders(cfg, toml, root)
	require.NoError(t, err)
	assert.Equal(t, 10, n, "five entries in each file")
	assert.Equal(t, []string{cfg, toml}, writes, "one write for Claude's file and one for Codex's, not ten")
	c, _ = os.ReadFile(cfg)
	assert.NotContains(t, string(c), "job-run-10")
	assert.Contains(t, string(c), "/keep/me")
	tb1, _ := os.ReadFile(toml) // #18091: the Codex file keeps its own entry and loses only the gone run folders'
	assert.NotContains(t, string(tb1), "job-run-10")
	assert.Contains(t, string(tb1), "/keep/me")
}
