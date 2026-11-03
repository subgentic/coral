package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Untracked folders in the changes views (#12524). A BIG untracked folder (more than 20 files, or 256 KiB) is one entry, as `git status` shows it: a sync tool's trace folder of hundreds of files is not a row
// each. A small one, a new package an agent wrote, stays file by file so its code can still be reviewed. An empty folder, and one that holds only ignored files, are not listed at all, as git status does not
// list them. Every ignore rule holds. The live diff, the stored diff and the Files list follow the same rule.

// tree writes n small files named f<i>.json into dir (under root).
func tree(t *testing.T, root, dir string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		p := filepath.Join(root, dir, fmt.Sprintf("f%02d.json", i))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte(fmt.Sprintf("{\"trace\": %d}\n", i)), 0o644))
	}
}

// scratchRepo is a repo with the folders of the rule: a big trace folder, a folder big by bytes, a small new package, empty folders, and ignore-only folders.
func scratchRepo(t *testing.T) string {
	repo := diffRepo(t)
	tree(t, repo, ".git.sync.traces/a", 30) // many files: folded
	for i := 0; i < 3; i++ {                // few files, many bytes: folded
		require.NoError(t, os.MkdirAll(filepath.Join(repo, "blob"), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(repo, "blob", fmt.Sprintf("big%d.txt", i)), []byte(strings.Repeat("x", 100<<10)), 0o644))
	}
	tree(t, repo, "pkg/newpkg", 2)                                                     // a new package: stays file by file
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "emptydir"), 0o755))            // empty: not listed
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "emptynest", "a", "b"), 0o755)) // empty, nested: not listed
	require.NoError(t, os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("onlyignored/*\n*.log\n"), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "onlyignored"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "onlyignored", "a.txt"), []byte("x\n"), 0o644)) // only ignored files: not listed
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "mixed"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "mixed", "run.log"), []byte("ignored\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "mixed", "keep.txt"), []byte("kept\n"), 0o644))
	return repo
}

func TestLiveChangesFoldABigUntrackedFolderAndKeepASmallOne(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := scratchRepo(t)
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	got := string(out)
	assert.Equal(t, 1, strings.Count(got, `new folder ".git.sync.traces/": 30 untracked files`), "the trace folder is one entry with its count: %s", got)
	assert.Equal(t, 1, strings.Count(got, `new folder "blob/": 3 untracked files, 300 KB`), "a folder big by bytes is folded too, with its size")
	assert.NotContains(t, got, "traces/a/f01.json", "no file of a folded folder is an entry of its own")
	assert.NotContains(t, got, "blob/big1.txt")
	assert.Contains(t, got, "+{\"trace\": 0}\n", "a small new package stays file by file (pkg/newpkg)")
	assert.Contains(t, got, "diff --git a/pkg/newpkg/f00.json b/pkg/newpkg/f00.json")
	assert.Contains(t, got, "diff --git a/mixed/keep.txt b/mixed/keep.txt", "the real file beside an ignored one is shown")
	for _, none := range []string{"emptydir", "emptynest", "onlyignored", "run.log"} {
		assert.NotContains(t, got, "diff --git a/"+none, none)
		assert.NotContains(t, got, `folder "`+none, none)
	}
}

// An untracked file in a folder that has tracked files is its own entry, as git status lists it.
func TestLiveChangesKeepUntrackedFilesInATrackedFolderWhole(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := diffRepo(t)
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "pkg"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "pkg", "a.go"), []byte("package pkg\n"), 0o644))
	gitIn(t, repo, "add", ".")
	gitIn(t, repo, "commit", "-q", "-m", "pkg")
	tree(t, repo, "pkg", 30) // many new files in a tracked folder: each is listed, git status lists them one by one
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	assert.Contains(t, string(out), "diff --git a/pkg/f29.json b/pkg/f29.json")
	assert.NotContains(t, string(out), `new folder "pkg/"`)
}

// Every git ignore rule hides a folder: .gitignore, .git/info/exclude and core.excludesFile.
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
		tree(t, repo, d, 30)
	}
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	got := string(out)
	assert.Contains(t, got, `new folder "shown/": 30 untracked files`)
	for _, d := range []string{"from-global", "from-exclude", "from-gitignore"} {
		assert.NotContains(t, got, `folder "`+d+`/"`, d) // .gitignore's own text names a folder, so the entry is what is checked
		assert.NotContains(t, got, d+"/f00.json", d)
	}
}

// The stored diff (the changes.diff of a task, what a Hub is sent) folds the same way, and names a hidden folder to no one.
func TestStoredDiffFoldsABigUntrackedFolderToo(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := scratchRepo(t)
	out, err := h.generatePersistedDiff(context.Background(), repo)
	require.NoError(t, err)
	got := string(out)
	assert.Contains(t, got, "a new hidden folder not shown (30 untracked files)", "a dot-folder is folded and not named")
	assert.NotContains(t, got, "git.sync.traces")
	assert.Contains(t, got, `new folder "blob/": 3 untracked files, 300 KB, not stored`)
	assert.NotContains(t, got, "big1.txt")
	assert.Contains(t, got, "+{\"trace\": 0}", "the small package's files are stored")
	for _, none := range []string{"emptydir", "emptynest", "onlyignored"} {
		assert.NotContains(t, got, none, none)
	}
}

// The Files list (the changed-files panel): the same rule: one row for a big folder (a path ending in "/"), a row per file of a small one, none for an empty or ignore-only folder.
func TestFilesListFoldsABigUntrackedFolder(t *testing.T) {
	r := newFollowRig(t, true)
	repo := scratchRepo2(t, r.launch)
	_ = repo
	body := r.list("")
	var paths []string
	for _, f := range body["files"].([]any) {
		paths = append(paths, f.(map[string]any)["filepath"].(string))
	}
	has := func(p string) bool {
		for _, x := range paths {
			if x == p {
				return true
			}
		}
		return false
	}
	assert.True(t, has(".git.sync.traces/"), "the trace folder is one row: %v", paths)
	assert.True(t, has("blob/"))
	assert.True(t, has("pkg/newpkg/f00.json"), "a small new package is a row per file")
	assert.True(t, has("mixed/keep.txt"))
	for _, p := range paths {
		assert.False(t, strings.HasPrefix(p, ".git.sync.traces/") && p != ".git.sync.traces/", "no row for a file inside the folded folder: %s", p)
		for _, none := range []string{"emptydir", "emptynest", "onlyignored"} {
			assert.False(t, strings.HasPrefix(p, none), p)
		}
	}
}

// scratchRepo2 fills an existing repo with the same folders as scratchRepo.
func scratchRepo2(t *testing.T, repo string) string {
	tree(t, repo, ".git.sync.traces/a", 30)
	for i := 0; i < 3; i++ {
		require.NoError(t, os.MkdirAll(filepath.Join(repo, "blob"), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(repo, "blob", fmt.Sprintf("big%d.txt", i)), []byte(strings.Repeat("x", 100<<10)), 0o644))
	}
	tree(t, repo, "pkg/newpkg", 2)
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "emptydir"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "emptynest", "a", "b"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("onlyignored/*\n*.log\n"), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "onlyignored"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "onlyignored", "a.txt"), []byte("x\n"), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "mixed"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "mixed", "run.log"), []byte("ignored\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "mixed", "keep.txt"), []byte("kept\n"), 0o644))
	return repo
}

// trackFolder commits one file in dir, so the folder is tracked and git lists its new files one by one.
func trackFolder(t *testing.T, repo, dir string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(repo, dir, ".tracked"), []byte("t\n"), 0o644))
	gitIn(t, repo, "add", filepath.Join(dir, ".tracked"))
	gitIn(t, repo, "commit", "-q", "-m", "track "+dir)
}

// Pins for QA's survivors on #12524 (#12543).

// An ignored file inside a SMALL untracked folder is not listed, by the folder's own .gitignore (the folder listing keeps --exclude-standard).
func TestAnIgnoredFileInASmallUntrackedFolderIsNotListed(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := diffRepo(t)
	require.NoError(t, os.MkdirAll(filepath.Join(repo, "mixed"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "mixed", ".gitignore"), []byte("*.log\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "mixed", "skip.log"), []byte("ignored\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "mixed", "keep.txt"), []byte("kept\n"), 0o644))
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	assert.Contains(t, string(out), "diff --git a/mixed/keep.txt b/mixed/keep.txt")
	assert.NotContains(t, string(out), "skip.log")
}

// A folder named with glob characters is a name, never a pattern: a folder named `*` is folded by its own files, and does not also count the folders `a/` and `b/` the pattern would match.
func TestAFolderNamedWithGlobCharactersIsALiteralName(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a folder named * cannot exist on Windows")
	}
	_, h, _, _ := setupSessionsTestServer(t)
	repo := diffRepo(t)
	tree(t, repo, "*", 30) // folded
	tree(t, repo, "a", 2)  // small: file by file
	tree(t, repo, "b", 2)
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	got := string(out)
	assert.Contains(t, got, `new folder "*/": 30 untracked files`, "its own 30 files, not 34")
	assert.Contains(t, got, "diff --git a/a/f00.json b/a/f00.json")
	assert.Contains(t, got, "diff --git a/b/f01.json b/b/f01.json")
}

// A link inside a folder is never followed: its target's size is not the folder's size. Five small files and a link to a 1 MB file elsewhere stay a small folder (file by file).
func TestALinkInAnUntrackedFolderIsNotFollowedForItsSize(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	repo := diffRepo(t)
	tree(t, repo, "linked", 5)
	big := filepath.Join(t.TempDir(), "big.bin")
	require.NoError(t, os.WriteFile(big, []byte(strings.Repeat("x", 1<<20)), 0o644))
	require.NoError(t, os.Symlink(big, filepath.Join(repo, "linked", "to-big")))
	out, err := h.generateChangesDiff(context.Background(), repo)
	require.NoError(t, err)
	got := string(out)
	assert.NotContains(t, got, `new folder "linked/"`, "the link's target is not counted: a small folder stays file by file")
	assert.Contains(t, got, "diff --git a/linked/f00.json b/linked/f00.json")
}

// The click on a folded row in the Files list (#12543): the single-file diff of "dir/" says what the folder is, not an empty panel.
func TestTheDiffOfAFoldedFolderRowSaysWhatItIs(t *testing.T) {
	r := newFollowRig(t, true)
	tree(t, r.launch, ".git.sync.traces/a", 30)
	req, err := http.NewRequest(http.MethodGet, r.server.URL+"/api/sessions/live/"+r.name+"/diff?session_id="+r.sid+"&filepath="+url.QueryEscape(".git.sync.traces/"), nil)
	require.NoError(t, err)
	req.Header.Set("Origin", r.server.URL)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Contains(t, body["diff"], `new folder ".git.sync.traces/": 30 untracked files`)
}
