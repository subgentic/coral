package gitutil

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// globName is the file name with glob characters in it: a Windows file name cannot hold '*', so there the brackets alone are the glob characters.
func globName() string {
	if runtime.GOOS == "windows" {
		return "[glob]x.txt"
	}
	return "[glob]*.txt"
}

// bigTree is a repo with n committed files, each then changed by i+1 added lines, so a file's count says which it is.
func bigTree(t *testing.T, n int) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		c := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=a@b", "-c", "user.name=x", "-c", "commit.gpgsign=false"}, args...)...)
		out, err := c.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run("init", "-q", ".")
	for i := 0; i < n; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d.txt", i)), []byte("base\n"), 0o644))
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, globName()), []byte("base\n"), 0o644))
	run("add", "-A")
	run("commit", "-qm", "base")
	for i := 0; i < n; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d.txt", i)), []byte("base\n"+strings.Repeat("x\n", i%7+1)), 0o644))
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, globName()), []byte("base\nmore\n"), 0o644))
	return dir
}

// #13155: a diff of more files than the cap is numbered for its first limit names only and says how many more there are; a smaller one is numbered whole, as before; every count is the plain numstat's.
func TestCappedNumstatNumbersOnlyTheRowsKeptAndSaysHowManyAreLeft(t *testing.T) {
	dir := bigTree(t, 40)
	old := numstatArgBytes
	numstatArgBytes = 60 // several batches
	t.Cleanup(func() { numstatArgBytes = old })
	ctx := context.Background()
	refs := []string{"HEAD"}
	plain, err := Command(ctx, dir, "diff", "HEAD", "--numstat", "-z").Output()
	require.NoError(t, err)
	want := map[string]string{}
	for _, rec := range strings.Split(string(plain), "\x00") {
		if parts := strings.SplitN(rec, "\t", 3); len(parts) == 3 {
			want[parts[2]] = parts[0] + "\t" + parts[1]
		}
	}
	require.Len(t, want, 41)
	parse := func(out []byte) map[string]string {
		got := map[string]string{}
		for _, rec := range strings.Split(string(out), "\x00") {
			if parts := strings.SplitN(rec, "\t", 3); len(parts) == 3 {
				got[parts[2]] = parts[0] + "\t" + parts[1]
			}
		}
		return got
	}
	// under the cap: whole, nothing left
	out, more, err := CappedNumstat(ctx, dir, refs, 100, true)
	require.NoError(t, err)
	assert.Equal(t, 0, more)
	assert.Equal(t, want, parse(out))
	// over the cap: the first 10 names, their own counts, 31 left; a glob character in a name is only a name
	out, more, err = CappedNumstat(ctx, dir, refs, 10, true)
	require.NoError(t, err)
	assert.Equal(t, 31, more)
	got := parse(out)
	assert.Len(t, got, 10)
	for p, c := range got {
		assert.Equal(t, want[p], c, p)
	}
	assert.Contains(t, got, globName(), "'[' sorts before 'f': the glob-named file is among the first by name, and numbered as itself")
	assert.NotContains(t, got, "f0039.txt")
	// the text form (no -z) the refresh route reads
	out, more, err = CappedNumstat(ctx, dir, refs, 10, false)
	require.NoError(t, err)
	assert.Equal(t, 31, more)
	assert.Len(t, strings.Split(strings.TrimSpace(string(out)), "\n"), 10)
	// no limit: plain
	out, more, err = CappedNumstat(ctx, dir, refs, 0, true)
	require.NoError(t, err)
	assert.Equal(t, 0, more)
	assert.Len(t, parse(out), 41)
	// a git failure is the plain command's failure
	_, _, err = CappedNumstat(ctx, dir, []string{"no-such-ref"}, 10, true)
	assert.Error(t, err)
}

// The pathspecs are folders where a folder is whole in the cut, so a big tree is one cheap diff, and files only where the cut runs through a folder or at the top.
func TestThePathspecsOfACutAreFoldersWhereTheFolderIsWholeInIt(t *testing.T) {
	sorted := []string{"a.txt", "d1/a", "d1/b", "d2/s1/x", "d2/s1/y", "d2/s2/z", "d3/a", "d3/b", "d4/a"}
	assert.Equal(t, []string{"a.txt", "d1", "d2"}, pathspecsFor(sorted, 6), "d1 and d2 are whole before the cut at d3/a")
	assert.Equal(t, []string{"a.txt", "d1", "d2/s1"}, pathspecsFor(sorted, 5), "the cut runs through d2 (the next path is d2/s2/z): its whole subfolder s1 is named, and the file s2/z is not in")
}

func TestCappedNumstatInANestedTreeMatchesThePlainCountsForTheRowsKept(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) {
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=a@b", "-c", "user.name=x", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run("init", "-q", ".")
	var all []string
	for d := 0; d < 6; d++ {
		for s := 0; s < 3; s++ {
			require.NoError(t, os.MkdirAll(filepath.Join(dir, fmt.Sprintf("d%d/s%d", d, s)), 0o755))
			for f := 0; f < 4; f++ {
				p := fmt.Sprintf("d%d/s%d/f%d.txt", d, s, f)
				require.NoError(t, os.WriteFile(filepath.Join(dir, p), []byte("base\n"), 0o644))
				all = append(all, p)
			}
		}
	}
	run("add", "-A")
	run("commit", "-qm", "base")
	for i, p := range all {
		require.NoError(t, os.WriteFile(filepath.Join(dir, p), []byte("base\n"+strings.Repeat("x\n", i%5+1)), 0o644))
	}
	ctx := context.Background()
	plain, err := Command(ctx, dir, "diff", "HEAD", "--numstat", "-z").Output()
	require.NoError(t, err)
	want := map[string]string{}
	for _, rec := range strings.Split(string(plain), "\x00") {
		if parts := strings.SplitN(rec, "\t", 3); len(parts) == 3 {
			want[parts[2]] = parts[0] + "\t" + parts[1]
		}
	}
	require.Len(t, want, 72)
	for _, limit := range []int{1, 5, 13, 30, 71} { // the cut falls in a file, a subfolder, a folder
		out, more, err := CappedNumstat(ctx, dir, []string{"HEAD"}, limit, true)
		require.NoError(t, err)
		assert.Equal(t, 72-limit, more, "limit %d", limit)
		got := map[string]string{}
		for _, rec := range strings.Split(string(out), "\x00") {
			if parts := strings.SplitN(rec, "\t", 3); len(parts) == 3 {
				got[parts[2]] = parts[0] + "\t" + parts[1]
			}
		}
		assert.GreaterOrEqual(t, len(got), limit, "limit %d: at least the rows kept", limit)
		for _, p := range all[:limit] { // sorted order is d0/s0/f0.. which is the creation order
			assert.Equal(t, want[p], got[p], "limit %d: %s", limit, p)
		}
		for p, c := range got {
			assert.Equal(t, want[p], c, "limit %d: any row given is the plain count", limit)
		}
	}
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=a@b", "-c", "user.name=x", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
	require.NoError(t, err, string(out))
}

func numstatRows(t *testing.T, out []byte) map[string]string {
	t.Helper()
	rows := map[string]string{}
	for _, rec := range strings.Split(string(out), "\x00") {
		if parts := strings.SplitN(rec, "\t", 3); len(parts) == 3 && parts[2] != "" {
			rows[parts[2]] = parts[0] + "\t" + parts[1]
		}
	}
	return rows
}

// QA Reviewer 2's SHOULDs on 825be2245 (#13181), the mutants that survived: names are taken literally (a name that reads as a glob is itself, and matches nothing else), a rename above the cap is a delete and an add (not a
// rename record the reader cannot place), and a long list of names goes in batches that fit a command line.
func TestCappedNumstatTakesNamesLiterallyAndRenamesAsADeleteAndAnAdd(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(dir, 0o755))
	gitRun(t, dir, "init", "-q", ".")
	for i := 0; i < 30; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d.txt", i)), []byte("base\n"), 0o644))
	}
	for _, n := range []string{"[x].txt", "x.txt", "A-old.txt"} { // "[x].txt" is a glob that matches "x.txt"
		require.NoError(t, os.WriteFile(filepath.Join(dir, n), []byte("base\nbase2\nbase3\n"), 0o644))
	}
	gitRun(t, dir, "add", "-A")
	gitRun(t, dir, "commit", "-qm", "base")
	for i := 0; i < 30; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d.txt", i)), []byte("base\nmore\n"), 0o644))
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, "[x].txt"), []byte("base\nbase2\nbase3\nchanged\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "x.txt"), []byte("base\nbase2\nbase3\nchanged\nchanged2\n"), 0o644))
	gitRun(t, dir, "mv", "A-old.txt", "A-new.txt") // a rename: both names are changed paths, and git would pair them
	ctx := context.Background()

	// limit 10: "A-new.txt", "A-old.txt" and "[x].txt" sort first ("A" and "[" before "f"); "x.txt" is beyond the cut
	out, more, err := CappedNumstat(ctx, dir, []string{"HEAD"}, 10, true)
	require.NoError(t, err)
	rows := numstatRows(t, out)
	assert.Equal(t, "1\t0", rows["[x].txt"], "the name is itself, taken literally")
	assert.NotContains(t, rows, "x.txt", "and the glob it reads as does not pull in the file it would match, beyond the cut")
	assert.Contains(t, rows, "A-old.txt", "a rename above the cap: the old name is a row of its own")
	assert.Contains(t, rows, "A-new.txt", "and so is the new one")
	assert.Equal(t, "0\t3", rows["A-old.txt"], "the old file's three lines are gone")
	assert.Equal(t, "3\t0", rows["A-new.txt"], "and the new one's three are added")
	assert.Equal(t, 34-10, more, "the rest of the 34 changed names (30 + [x] + x + old + new) are counted, not numbered")
}

func TestCappedNumstatBatchesALongListOfNamesUnderTheCommandLineLimit(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", ".")
	long := strings.Repeat("n", 100)
	var names []string
	for i := 0; i < 30; i++ {
		n := fmt.Sprintf("%s-%02d.txt", long, i)
		names = append(names, n)
		require.NoError(t, os.WriteFile(filepath.Join(dir, n), []byte("base\n"), 0o644))
	}
	gitRun(t, dir, "add", "-A")
	gitRun(t, dir, "commit", "-qm", "base")
	for _, n := range names {
		require.NoError(t, os.WriteFile(filepath.Join(dir, n), []byte("base\nmore\n"), 0o644))
	}
	old := numstatArgBytes
	numstatArgBytes = 1000 // about nine of these names to a command
	var batches []int
	numstatBatchHook = func(n int) { batches = append(batches, n) }
	t.Cleanup(func() { numstatArgBytes = old; numstatBatchHook = func(int) {} })
	out, more, err := CappedNumstat(context.Background(), dir, []string{"HEAD"}, 25, true)
	require.NoError(t, err)
	rows := numstatRows(t, out)
	assert.Len(t, rows, 25, "every kept name is numbered, across the batches")
	assert.Equal(t, 5, more)
	assert.GreaterOrEqual(t, len(batches), 3, "25 names of 103 bytes under a 1,000-byte line are three batches or more, not one")
	total := 0
	for _, n := range batches {
		assert.LessOrEqual(t, n, 10, "no batch is more than fits")
		total += n
	}
	assert.Equal(t, 25, total)
}

// The Orchestrator's tiny assert on #13181: the production batch size fits a Windows command line (32 KB in all; the git path, the options and the separators are on it too).
func TestTheProductionNumstatBatchFitsAWindowsCommandLine(t *testing.T) {
	assert.LessOrEqual(t, numstatArgBytes, 32<<10, "the names of one batch leave room for the rest of the command under the 32 KB limit")
	assert.Equal(t, 20<<10, numstatArgBytes, "and it is the size the commit says")
}
