package releasediff

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTheModulePathIsReadFromGoMod(t *testing.T) {
	m, err := ModulePath([]byte("// c\nmodule github.com/subgentic/coral\n\ngo 1.26\n"))
	require.NoError(t, err)
	assert.Equal(t, "github.com/subgentic/coral", m)
	_, err = ModulePath([]byte("go 1.26\n"))
	assert.Error(t, err)
}

func TestOnlyTheModulesOwnImportsAreFollowed(t *testing.T) {
	src := "package x\n\nimport (\n\t\"fmt\"\n\t\"github.com/stretchr/testify/assert\"\n\t\"github.com/subgentic/coral/internal/httputil\"\n\tsg \"github.com/subgentic/coral/internal/safego\"\n\t_ \"github.com/subgentic/coral/pkg/redact\"\n\t\"github.com/subgentic/coralish/other\"\n)\n"
	got, err := ImportedDirs(map[string][]byte{"a.go": []byte(src), "b.go": []byte("package x\nimport \"github.com/subgentic/coral/internal/httputil\"\n")}, "github.com/subgentic/coral")
	require.NoError(t, err)
	assert.Equal(t, []string{"coral-go/internal/httputil", "coral-go/internal/safego", "coral-go/pkg/redact"}, got,
		"the module's packages, once each, with an alias or a blank import counted; another module whose name starts the same is not ours")
	_, err = ImportedDirs(map[string][]byte{"bad.go": []byte("package x\nimport (\n")}, "m")
	require.Error(t, err, "a file that does not parse is an error, not a package left out")
	assert.Contains(t, err.Error(), "bad.go")
}

// An import path whose rest could widen a pathspec or leave coral-go/ is refused, not followed: Security's hardening on #12344.
func TestAnImportPathThatIsNotAPlainDirectoryIsRefused(t *testing.T) {
	const m = "github.com/subgentic/coral"
	for _, rest := range []string{"internal/../../etc", "..", "internal//safego", "internal/", "internal/*", "internal/safe?o", "internal/[a]", "internal:x", "internal/./safego"} {
		src := "package x\nimport _ \"" + m + "/" + rest + "\"\n"
		_, err := ImportedDirs(map[string][]byte{"a.go": []byte(src)}, m)
		require.Error(t, err, rest)
		assert.Contains(t, err.Error(), "not a plain package path", rest)
	}
	_, err := ImportedDirs(map[string][]byte{"a.go": []byte("package x\nimport _ `" + m + "/internal\\x`\n")}, m) // a raw string: one backslash in the path
	require.Error(t, err, "a backslash")
	assert.Contains(t, err.Error(), "not a plain package path")
	got, err := ImportedDirs(map[string][]byte{"a.go": []byte("package x\nimport _ \"" + m + "/pkg/redact/betterleaks\"\nimport _ \"" + m + "/internal/safe-go_2\"\n")}, m)
	require.NoError(t, err)
	assert.Equal(t, []string{"coral-go/internal/safe-go_2", "coral-go/pkg/redact/betterleaks"}, got, "a nested package and ordinary punctuation are fine")
	got, err = ImportedDirs(map[string][]byte{"a.go": []byte("package x\nimport _ \"github.com/other/mod/../x\"\n")}, m)
	require.NoError(t, err, "an import of another module is not ours to check")
	assert.Empty(t, got)
}

func TestTheClosureFollowsImportsThroughEachOtherOnceWithWhoFoundThem(t *testing.T) {
	graph := map[string][]string{
		"r1": {"a", "b"}, "r2": {"b"}, "a": {"c", "r1"}, "b": {"c"}, "c": {}, // r1 -> a -> r1 is a cycle
	}
	got, err := Closure([]string{"r1", "r2", "r1"}, func(d string) ([]string, error) { return graph[d], nil })
	require.NoError(t, err)
	assert.Equal(t, []Dep{{Dir: "r1"}, {Dir: "r2"}, {Dir: "a", Via: "r1"}, {Dir: "b", Via: "r1"}, {Dir: "c", Via: "a"}}, got)
}

func TestTheClosuresOfTwoRefsSayWhoJoinedAndWhoLeft(t *testing.T) {
	oldC := []Dep{{Dir: "coral-go/pkg/hubproxy"}, {Dir: "coral-go/internal/a", Via: "coral-go/pkg/hubproxy"}, {Dir: "coral-go/internal/gone", Via: "coral-go/pkg/hubproxy"}}
	newC := []Dep{{Dir: "coral-go/pkg/hubproxy"}, {Dir: "coral-go/internal/a", Via: "coral-go/pkg/hubproxy"}, {Dir: "coral-go/internal/fresh", Via: "coral-go/internal/a"}}
	files := []FileChange{
		{Path: "coral-go/internal/a/a.go", Added: 3, Deleted: 1},
		{Path: "coral-go/internal/a/sub/deep.go", Added: 9}, // a package below it is its own package
		{Path: "coral-go/internal/fresh/f.go", Added: 5},
	}
	got := CompareClosures(oldC, newC, []string{"coral-go/pkg/hubproxy"}, files)
	require.Len(t, got, 3, "the root is the other section's")
	byDir := map[string]DepChange{}
	for _, d := range got {
		byDir[d.Dir] = d
	}
	assert.Equal(t, DepChange{Dir: "coral-go/internal/a", Via: "coral-go/pkg/hubproxy", Files: files[:1]}, byDir["coral-go/internal/a"])
	assert.True(t, byDir["coral-go/internal/fresh"].Joined)
	assert.Equal(t, "coral-go/internal/a", byDir["coral-go/internal/fresh"].Via)
	assert.True(t, byDir["coral-go/internal/gone"].Left)
	assert.False(t, byDir["coral-go/internal/a"].Joined || byDir["coral-go/internal/a"].Left)
}

func TestTheDependencyReportNamesWhoImportsItAndWhatJoinedOrLeft(t *testing.T) {
	var sb strings.Builder
	WriteDependencies(&sb, []DepChange{
		{Dir: "coral-go/internal/a", Via: "coral-go/pkg/hubproxy", Files: []FileChange{{Path: "coral-go/internal/a/a.go", Added: 3, Deleted: 1}, {Path: "coral-go/internal/a/a_test.go", Added: 20}}},
		{Dir: "coral-go/internal/fresh", Via: "coral-go/internal/a", Joined: true},
		{Dir: "coral-go/internal/gone", Via: "coral-go/pkg/hubproxy", Left: true},
		{Dir: "coral-go/internal/still"},
	}, "v1", "v2")
	out := sb.String()
	assert.Contains(t, out, "### Coral packages compiled into the Hub through its imports, v1 to v2")
	assert.Contains(t, out, "`internal/a`: 1 file of Go code changed (+3, -1), imported by `pkg/hubproxy`")
	assert.Contains(t, out, "- `coral-go/internal/a/a.go`: +3, -1")
	assert.Contains(t, out, "- test files, not compiled by the Hub: 1 file (+20, -0)")
	assert.Contains(t, out, "`internal/fresh`: 0 files of Go code changed (+0, -0), imported by `internal/a`, new in the Hub's imports")
	assert.Contains(t, out, "no longer in the Hub's imports")
	assert.Contains(t, out, "Unchanged: `internal/still`.")
	sb.Reset()
	WriteDependencies(&sb, nil, "v1", "v2")
	assert.Contains(t, sb.String(), "import nothing else from this module")
}

// DependencyChanges on a real repository: hubproxy imports a and e, a imports b, c is imported by nobody; b gains an import of d and hubproxy drops e in the new commit; a, b, c, d and e change.
func TestDependencyChangesFollowTheImportsOfARealRepository(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	put := func(path, body string) {
		t.Helper()
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(repo, path)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(repo, path), []byte(body), 0o644))
	}
	const m = "example.invalid/m"
	put("coral-go/go.mod", "module "+m+"\n\ngo 1.26\n")
	put("coral-go/pkg/hubproxy/h.go", "package hubproxy\nimport (\n\t_ \""+m+"/internal/a\"\n\t_ \""+m+"/internal/e\"\n)\n")
	put("coral-go/internal/e/e.go", "package e\n")
	put("coral-go/internal/a/a.go", "package a\nimport _ \""+m+"/internal/b\"\n")
	put("coral-go/internal/b/b.go", "package b\n")
	put("coral-go/internal/c/c.go", "package c\n")
	put("coral-go/internal/d/d.go", "package d\n")
	run("init", "-q")
	run("add", "-A")
	run("commit", "-q", "-m", "old")
	run("tag", "old")
	put("coral-go/internal/a/a.go", "package a\nimport _ \""+m+"/internal/b\"\n\nvar A = 1\n")
	put("coral-go/internal/b/b.go", "package b\nimport _ \""+m+"/internal/d\"\n\nvar B = 1\n")
	put("coral-go/internal/c/c.go", "package c\n\nvar C = 1\n") // nobody in the Hub imports it
	put("coral-go/internal/d/d.go", "package d\n\nvar D = 1\n")
	put("coral-go/pkg/hubproxy/h.go", "package hubproxy\nimport _ \""+m+"/internal/a\"\n") // e leaves the Hub's imports, and changes in the same commit
	put("coral-go/internal/e/e.go", "package e\n\nvar E = 1\n")
	run("add", "-A")
	run("commit", "-q", "-m", "new")
	run("tag", "new")

	for _, dir := range []string{repo, filepath.Join(repo, "coral-go")} {
		dcs, err := DependencyChanges(dir, "old", "new")
		require.NoError(t, err, dir)
		got := map[string]DepChange{}
		for _, d := range dcs {
			got[d.Dir] = d
		}
		require.Len(t, got, 4, "from "+dir+": a, b, d and e are the Hub's in one ref or the other; c is not")
		assert.True(t, got["coral-go/internal/e"].Left, "e left the Hub's imports")
		assert.Len(t, got["coral-go/internal/e"].Files, 1, "and its change is still listed: the old closure's directories are read too")
		assert.Len(t, got["coral-go/internal/a"].Files, 1)
		assert.Equal(t, "coral-go/pkg/hubproxy", got["coral-go/internal/a"].Via)
		assert.Equal(t, "coral-go/internal/a", got["coral-go/internal/b"].Via)
		assert.True(t, got["coral-go/internal/d"].Joined, "d joined through b")
		assert.Len(t, got["coral-go/internal/d"].Files, 1)
		assert.NotContains(t, got, "coral-go/internal/c")
	}
	_, err := DependencyChanges(repo, "old", "no-such-tag")
	assert.Error(t, err)
}
