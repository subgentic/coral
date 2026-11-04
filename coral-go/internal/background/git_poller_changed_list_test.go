package background

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"
)

// The changed-files list is the same on every pass when nothing changed, and an untracked folder is its files (#13079: the Operator's 35k changes 'is not an accurate file diff').

func repoWithTracked(t *testing.T, n int) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	runGit(t, dir, "init", "-q", "-b", "main")
	for i := 0; i < n; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("f-%05d.txt", i)), []byte("x\n"), 0o644))
	}
	runGit(t, dir, "add", ".")
	runGit(t, dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base")
	return dir
}

// More changes than the cap: which files are kept must not depend on Go's map order, or the list a person sees changes on every poll with nothing changed and every pass rewrites it.
func TestGitPollKeepsTheSameFilesWhenNothingChanged(t *testing.T) {
	dir := repoWithTracked(t, maxChangedFiles+400)
	for i := 0; i < maxChangedFiles+400; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("f-%05d.txt", i)), []byte("y\n"), 0o644))
	}
	sid := "s-same"
	p, gs := newPollerFor(t, dir, sid)
	read := func() []string {
		files, found, err := gs.GetChangedFiles(context.Background(), "", &sid, "branch_point")
		require.NoError(t, err)
		require.True(t, found)
		var out []string
		for _, f := range files {
			out = append(out, f.Filepath)
		}
		sort.Strings(out)
		return out
	}
	require.NoError(t, p.PollOnce(context.Background()))
	first := read()
	require.Len(t, first, maxChangedFiles)
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, first, read(), "the same 2000 files after a second poll with nothing changed")
	require.Equal(t, "f-00000.txt", first[0], "the kept files are the first by name, not an arbitrary subset")
}

// An untracked folder: git status (normal) names the folder, 'gen/'; the list must hold the files in it.
func TestGitPollListsTheFilesOfAnUntrackedFolder(t *testing.T) {
	dir := repoWithTracked(t, 1)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "gen", "sub"), 0o755))
	for _, n := range []string{"gen/a.txt", "gen/b.txt", "gen/sub/c.txt"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, n), []byte("z\n"), 0o644))
	}
	sid := "s-untracked"
	p, gs := newPollerFor(t, dir, sid)
	require.NoError(t, p.PollOnce(context.Background()))
	files, _, err := gs.GetChangedFiles(context.Background(), "", &sid, "branch_point")
	require.NoError(t, err)
	var got []string
	for _, f := range files {
		got = append(got, f.Filepath)
	}
	sort.Strings(got)
	require.Equal(t, []string{"gen/a.txt", "gen/b.txt", "gen/sub/c.txt"}, got, "three new files, not one 'gen/' entry")
}
