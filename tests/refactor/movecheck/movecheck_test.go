package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// repo is a throwaway git repository the tests commit to; its identity is set in the environment so no global git config is read or needed.
type repo struct {
	t   *testing.T
	dir string
}

func newRepo(t *testing.T) *repo {
	t.Helper()
	r := &repo{t: t, dir: t.TempDir()}
	r.git("init", "-q")
	return r
}

func (r *repo) git(args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", append([]string{"-C", r.dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Move Check", "GIT_AUTHOR_EMAIL=movecheck@example.invalid",
		"GIT_COMMITTER_NAME=Move Check", "GIT_COMMITTER_EMAIL=movecheck@example.invalid", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// commit replaces the repository's files with files (a name to its text; an empty text deletes) and returns the new commit.
func (r *repo) commit(files map[string]string) string {
	r.t.Helper()
	for name, text := range files {
		p := filepath.Join(r.dir, name)
		if text == "" {
			os.Remove(p)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			r.t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			r.t.Fatal(err)
		}
	}
	r.git("add", "-A")
	r.git("commit", "-q", "--allow-empty", "-m", "c")
	return r.git("rev-parse", "HEAD")
}

func (r *repo) compare(old, cur string, roots ...string) []string {
	r.t.Helper()
	o, err := load(r.dir, old, roots, false)
	if err != nil {
		r.t.Fatal(err)
	}
	c, err := load(r.dir, cur, roots, false)
	if err != nil {
		r.t.Fatal(err)
	}
	return compare(o, c)
}

const oneFile = `package store

import "fmt"

// Greeting says hello.
func Greeting(name string) string {
	return fmt.Sprintf("hello %s", name)
}

type Box struct {
	N int
}

func (b *Box) Double() int {
	return b.N * 2
}

const (
	A = iota
	B
)

var table = map[string]int{"a": 1}
`

func TestARealMovePasses(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile})
	after := r.commit(map[string]string{
		"store/all.go": "package store\n\n// Greeting says hello.\nfunc Greeting(name string) string {\n\treturn fmt.Sprintf(\"hello %s\", name)\n}\n",
		"store/box.go": `package store

type Box struct {
	N int
}

func (b *Box) Double() int {
	return b.N * 2
}
`,
		"store/consts.go": `package store

import "os"

const (
	A = iota
	B
)

var table = map[string]int{"a": 1}

var _ = os.Args
`,
	})
	// the imports differ and a blank var is added in the new file: the var is a declaration, so this is not a pure move yet
	if got := r.compare(before, after, "store"); len(got) != 1 || !strings.HasPrefix(got[0], "ADDED") {
		t.Fatalf("an added declaration must be reported, got %q", got)
	}
	after = r.commit(map[string]string{"store/consts.go": `package store

const (
	A = iota
	B
)

var table = map[string]int{"a": 1}
`})
	if got := r.compare(before, after, "store"); len(got) != 0 {
		t.Fatalf("a move across files, with other imports and file order, must pass: %q", got)
	}
}

func TestOneCharacterChangeFailsAndNamesTheFunction(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile})
	after := r.commit(map[string]string{"store/all.go": strings.Replace(oneFile, "b.N * 2", "b.N * 3", 1)})
	got := r.compare(before, after, "store")
	if len(got) != 1 || !strings.HasPrefix(got[0], "CHANGED") || !strings.Contains(got[0], "method Box") || !strings.Contains(got[0], "Double") {
		t.Fatalf("want one CHANGED naming Box.Double, got %q", got)
	}
	if !strings.Contains(got[0], "b.N * 2") || !strings.Contains(got[0], "b.N * 3") {
		t.Fatalf("the first differing line is shown: %q", got[0])
	}
}

func TestADroppedFunctionFails(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile})
	dropped := strings.Replace(oneFile, "func (b *Box) Double() int {\n\treturn b.N * 2\n}\n", "", 1)
	after := r.commit(map[string]string{"store/all.go": dropped})
	got := r.compare(before, after, "store")
	if len(got) != 1 || !strings.HasPrefix(got[0], "MISSING") || !strings.Contains(got[0], "Double") {
		t.Fatalf("want one MISSING naming Double, got %q", got)
	}
}

func TestADocCommentChangeFailsButAFreeCommentDoesNot(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile})
	free := r.commit(map[string]string{"store/all.go": "// a note that belongs to no declaration\n\n" + oneFile})
	if got := r.compare(before, free, "store"); len(got) != 0 {
		t.Fatalf("a free-standing comment is not a declaration: %q", got)
	}
	doc := r.commit(map[string]string{"store/all.go": strings.Replace(oneFile, "Greeting says hello.", "Greeting says hi.", 1)})
	if got := r.compare(before, doc, "store"); len(got) != 1 || !strings.HasPrefix(got[0], "CHANGED") {
		t.Fatalf("a doc comment is part of the declaration: %q", got)
	}
}

func TestSplittingAConstGroupIsNotAMove(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile})
	after := r.commit(map[string]string{"store/all.go": strings.Replace(oneFile, "const (\n\tA = iota\n\tB\n)", "const A = 0\n\nconst B = 1", 1)})
	if got := r.compare(before, after, "store"); len(got) == 0 {
		t.Fatal("a const group with iota is one declaration; rewriting it must fail")
	}
}

func TestBuildContextKeepsPlatformFilesApart(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{
		"p/open_windows.go": "package p\n\nfunc open() string { return \"w\" }\n",
		"p/open_other.go":   "//go:build !windows\n\npackage p\n\nfunc open() string { return \"o\" }\n",
	})
	if got := r.compare(before, before, "p"); len(got) != 0 {
		t.Fatalf("two platforms may declare one name: %q", got)
	}
	after := r.commit(map[string]string{"p/open_other.go": "//go:build !windows\n\npackage p\n\nfunc open() string { return \"x\" }\n"})
	got := r.compare(before, after, "p")
	if len(got) != 1 || !strings.HasPrefix(got[0], "CHANGED") || !strings.Contains(got[0], "!windows") {
		t.Fatalf("the change is in the !windows copy: %q", got)
	}
}

func TestSeveralInitFunctionsAreAMultiset(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{
		"p/a.go": "package p\n\nfunc init() { x = append(x, 1) }\n\nvar x []int\n",
		"p/b.go": "package p\n\nfunc init() { x = append(x, 2) }\n",
	})
	moved := r.commit(map[string]string{
		"p/a.go": "package p\n\nvar x []int\n",
		"p/b.go": "package p\n\nfunc init() { x = append(x, 2) }\n\nfunc init() { x = append(x, 1) }\n",
	})
	if got := r.compare(before, moved, "p"); len(got) != 0 {
		t.Fatalf("both init functions are still there: %q", got)
	}
	lost := r.commit(map[string]string{"p/b.go": "package p\n\nfunc init() { x = append(x, 2) }\n"})
	if got := r.compare(before, lost, "p"); len(got) != 1 || !strings.HasPrefix(got[0], "MISSING") {
		t.Fatalf("a dropped init is reported: %q", got)
	}
}

func TestCRLFFilesCompareLikeLF(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile})
	after := r.commit(map[string]string{"store/all.go": strings.ReplaceAll(oneFile, "\n", "\r\n")})
	if got := r.compare(before, after, "store"); len(got) != 0 {
		t.Fatalf("line endings are not a change: %q", got)
	}
}

func TestPathsAndTestdataAreRespected(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile, "other/x.go": "package other\n\nfunc X() {}\n", "store/testdata/t.go": "package bad ((("})
	after := r.commit(map[string]string{"other/x.go": "package other\n\nfunc X() { println() }\n"})
	if got := r.compare(before, after, "store"); len(got) != 0 {
		t.Fatalf("only store is compared (and testdata is skipped): %q", got)
	}
	if got := r.compare(before, after); len(got) != 1 {
		t.Fatalf("without paths the other folder is compared too: %q", got)
	}
}

func TestTheWorkingTreeCanBeTheNewRevision(t *testing.T) {
	r := newRepo(t)
	before := r.commit(map[string]string{"store/all.go": oneFile})
	if err := os.WriteFile(filepath.Join(r.dir, "store", "all.go"), []byte(strings.Replace(oneFile, "hello", "bye", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := r.compare(before, worktree, "store"); len(got) != 1 || !strings.HasPrefix(got[0], "CHANGED") {
		t.Fatalf("the uncommitted edit is a change: %q", got)
	}
}
