// Package main is movecheck: it proves that a refactor only moved Go code. Given two git revisions it parses every Go file under the chosen
// paths and asserts that both revisions hold the same top-level declarations with byte-identical text, wherever they sit: the same functions
// and methods, the same type, const and var declarations, the same doc comments. File placement and import blocks are ignored. A changed,
// missing or added declaration is named and the exit status is 1.
package main

import (
	"bufio"
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"os/exec"
	"path"
	"sort"
	"strings"
)

// worktree is the revision name that reads the files on disk instead of a commit.
const worktree = "WORKTREE"

// decl is one top-level declaration: where it was, and its exact text.
type decl struct {
	file, text string
	line       int
}

// index maps a declaration's identity to every copy of it (a package may hold several init functions, so it is a multiset).
type index map[string][]decl

func main() {
	repo := flag.String("repo", ".", "the git repository")
	oldRev := flag.String("old", "", "the revision before the refactor (a commit, tag or branch)")
	newRev := flag.String("new", "", "the revision after the refactor, or "+worktree+" for the files on disk")
	paths := flag.String("paths", "", "comma-separated folders (relative to the repository root) to compare; default: all")
	skipTests := flag.Bool("skip-tests", false, "leave out _test.go files")
	flag.Parse()
	if *oldRev == "" || *newRev == "" {
		fmt.Fprintln(os.Stderr, "usage: movecheck -old <rev> -new <rev|WORKTREE> [-repo dir] [-paths a,b] [-skip-tests]")
		os.Exit(2)
	}
	var roots []string
	for _, p := range strings.Split(*paths, ",") {
		if p = strings.Trim(strings.TrimSpace(p), "/"); p != "" {
			roots = append(roots, p)
		}
	}
	old, err := load(*repo, *oldRev, roots, *skipTests)
	if err != nil {
		fmt.Fprintln(os.Stderr, "movecheck:", err)
		os.Exit(2)
	}
	cur, err := load(*repo, *newRev, roots, *skipTests)
	if err != nil {
		fmt.Fprintln(os.Stderr, "movecheck:", err)
		os.Exit(2)
	}
	problems := compare(old, cur)
	if len(problems) == 0 {
		fmt.Printf("movecheck: ok: %d declarations are the same in %s and %s\n", count(old), *oldRev, *newRev)
		return
	}
	for _, p := range problems {
		fmt.Println(p)
	}
	fmt.Printf("movecheck: %d difference(s) between %s and %s: this is not a move-only change\n", len(problems), *oldRev, *newRev)
	os.Exit(1)
}

func count(ix index) int {
	n := 0
	for _, v := range ix {
		n += len(v)
	}
	return n
}

// compare lists what differs, sorted: a declaration missing from the new revision, added in it, or present in both with other text.
func compare(old, cur index) []string {
	var out []string
	keys := map[string]bool{}
	for k := range old {
		keys[k] = true
	}
	for k := range cur {
		keys[k] = true
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	for _, k := range sorted {
		o, c := old[k], cur[k]
		// Match identical texts first (a move), then pair what is left: the same identity with another text is a change.
		o, c = removeEqual(o, c)
		for len(o) > 0 && len(c) > 0 {
			out = append(out, fmt.Sprintf("CHANGED %s\n    was %s:%d\n    now %s:%d\n%s", display(k), o[0].file, o[0].line, c[0].file, c[0].line, firstDifference(o[0].text, c[0].text)))
			o, c = o[1:], c[1:]
		}
		for _, d := range o {
			out = append(out, fmt.Sprintf("MISSING %s (was %s:%d)", display(k), d.file, d.line))
		}
		for _, d := range c {
			out = append(out, fmt.Sprintf("ADDED   %s (now %s:%d)", display(k), d.file, d.line))
		}
	}
	return out
}

// removeEqual drops from both lists every declaration whose text appears in the other (each text matches once).
func removeEqual(a, b []decl) ([]decl, []decl) {
	var restA []decl
	used := make([]bool, len(b))
next:
	for _, x := range a {
		for i, y := range b {
			if !used[i] && x.text == y.text {
				used[i] = true
				continue next
			}
		}
		restA = append(restA, x)
	}
	var restB []decl
	for i, y := range b {
		if !used[i] {
			restB = append(restB, y)
		}
	}
	return restA, restB
}

// display turns an identity (folder, build context, kind and names) into one readable line.
func display(key string) string {
	return strings.ReplaceAll(key, "\x00", " | ")
}

// firstDifference shows the first line that differs between two texts.
func firstDifference(a, b string) string {
	al, bl := strings.Split(a, "\n"), strings.Split(b, "\n")
	for i := 0; i < len(al) || i < len(bl); i++ {
		var x, y string
		if i < len(al) {
			x = al[i]
		}
		if i < len(bl) {
			y = bl[i]
		}
		if x != y {
			return fmt.Sprintf("    line %d of the declaration:\n      - %s\n      + %s", i+1, clip(x), clip(y))
		}
	}
	return "    (the texts differ)"
}

func clip(s string) string {
	if len(s) > 160 {
		return s[:160] + "..."
	}
	return s
}

// load reads every Go file of a revision under roots and indexes its top-level declarations.
func load(repo, rev string, roots []string, skipTests bool) (index, error) {
	ix := index{}
	keep := func(f string) bool {
		return strings.HasSuffix(f, ".go") && !strings.Contains("/"+f, "/testdata/") && !(skipTests && strings.HasSuffix(f, "_test.go"))
	}
	if rev != worktree {
		return ix, loadFromGit(ix, repo, rev, roots, keep)
	}
	files, err := listFiles(repo, rev, roots)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		if !keep(f) {
			continue
		}
		src, err := os.ReadFile(path.Join(repo, f))
		if err != nil {
			return nil, err
		}
		if err := indexFile(ix, f, src); err != nil {
			return nil, err
		}
	}
	return ix, nil
}

// loadFromGit lists a revision's tree once and reads every wanted blob through one git cat-file --batch process (a process per file takes
// minutes on this repository).
func loadFromGit(ix index, repo, rev string, roots []string, keep func(string) bool) error {
	args := []string{"-C", repo, "ls-tree", "-r", rev}
	if len(roots) > 0 {
		args = append(args, "--")
		args = append(args, roots...)
	}
	listing, err := run("git", args...)
	if err != nil {
		return fmt.Errorf("git ls-tree %s: %w", rev, err)
	}
	type blob struct{ sha, file string }
	var blobs []blob
	for _, l := range strings.Split(strings.TrimSpace(string(listing)), "\n") {
		// "<mode> blob <sha>\t<path>"
		tab := strings.IndexByte(l, '\t')
		if tab < 0 {
			continue
		}
		fields := strings.Fields(l[:tab])
		if len(fields) != 3 || fields[1] != "blob" || !keep(l[tab+1:]) {
			continue
		}
		blobs = append(blobs, blob{fields[2], l[tab+1:]})
	}
	cmd := exec.Command("git", "-C", repo, "cat-file", "--batch")
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		for _, b := range blobs {
			fmt.Fprintln(in, b.sha)
		}
		in.Close()
	}()
	r := bufio.NewReader(out)
	for _, b := range blobs {
		header, err := r.ReadString('\n')
		if err != nil {
			return fmt.Errorf("git cat-file %s: %w", b.file, err)
		}
		var sha, typ string
		var size int
		if _, err := fmt.Sscanf(header, "%s %s %d", &sha, &typ, &size); err != nil || typ != "blob" {
			return fmt.Errorf("git cat-file %s: unexpected answer %q", b.file, strings.TrimSpace(header))
		}
		src := make([]byte, size+1) // the blob and the newline that follows it
		if _, err := io.ReadFull(r, src); err != nil {
			return fmt.Errorf("git cat-file %s: %w", b.file, err)
		}
		if err := indexFile(ix, b.file, src[:size]); err != nil {
			return err
		}
	}
	return cmd.Wait()
}

// listFiles lists the files on disk under roots (the working tree).
func listFiles(repo, rev string, roots []string) ([]string, error) {
	var out []string
	walkRoots := roots
	if len(walkRoots) == 0 {
		walkRoots = []string{"."}
	}
	for _, r := range walkRoots {
		if err := walkDir(repo, r, &out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func walkDir(repo, rel string, out *[]string) error {
	entries, err := os.ReadDir(path.Join(repo, rel))
	if err != nil {
		return err
	}
	for _, e := range entries {
		p := path.Join(rel, e.Name())
		if rel == "." {
			p = e.Name()
		}
		if e.IsDir() {
			if e.Name() == ".git" || e.Name() == "node_modules" {
				continue
			}
			if err := walkDir(repo, p, out); err != nil {
				return err
			}
			continue
		}
		*out = append(*out, p)
	}
	return nil
}

func run(name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// indexFile adds a file's top-level declarations to ix. A declaration's identity is its folder, its package name, the build context of its
// file (a //go:build line and a _GOOS or _GOARCH file suffix: foo_windows.go and foo_unix.go may declare one name each) and its kind and
// names; its text runs from its doc comment to its last byte.
func indexFile(ix index, file string, src []byte) error {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, src, parser.ParseComments)
	if err != nil {
		return fmt.Errorf("%s: %w", file, err)
	}
	ctx := buildContext(file, src)
	dir := path.Dir(file)
	base := dir + "\x00" + f.Name.Name + "\x00" + ctx + "\x00"
	text := func(from, to token.Pos) string {
		s, e := fset.Position(from).Offset, fset.Position(to).Offset
		return strings.ReplaceAll(string(src[s:e]), "\r\n", "\n")
	}
	add := func(key string, d ast.Node, doc *ast.CommentGroup) {
		start := d.Pos()
		if doc != nil {
			start = doc.Pos()
		}
		ix[key] = append(ix[key], decl{file: file, line: fset.Position(start).Line, text: text(start, d.End())})
	}
	for _, d := range f.Decls {
		switch x := d.(type) {
		case *ast.FuncDecl:
			name := x.Name.Name
			kind := "func"
			if x.Recv != nil && len(x.Recv.List) > 0 {
				kind = "method " + recvName(x.Recv.List[0].Type)
			}
			add(base+kind+"\x00"+name, x, x.Doc)
		case *ast.GenDecl:
			if x.Tok == token.IMPORT {
				continue
			}
			add(base+x.Tok.String()+"\x00"+strings.Join(declNames(x), ","), x, x.Doc)
		}
	}
	return nil
}

func recvName(t ast.Expr) string {
	switch x := t.(type) {
	case *ast.StarExpr:
		return recvName(x.X)
	case *ast.IndexExpr:
		return recvName(x.X)
	case *ast.IndexListExpr:
		return recvName(x.X)
	case *ast.Ident:
		return x.Name
	}
	return "?"
}

func declNames(g *ast.GenDecl) []string {
	var names []string
	for _, sp := range g.Specs {
		switch s := sp.(type) {
		case *ast.TypeSpec:
			names = append(names, s.Name.Name)
		case *ast.ValueSpec:
			for _, n := range s.Names {
				names = append(names, n.Name)
			}
		}
	}
	if len(names) == 0 {
		names = []string{"_"}
	}
	return names
}

// buildContext is what decides whether a file is built: its //go:build line and the GOOS or GOARCH in its name.
func buildContext(file string, src []byte) string {
	ctx := []string{}
	for _, l := range strings.Split(string(src), "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "//go:build ") {
			ctx = append(ctx, strings.TrimSpace(strings.TrimPrefix(t, "//go:build ")))
			break
		}
		if strings.HasPrefix(t, "package ") {
			break
		}
	}
	name := strings.TrimSuffix(path.Base(file), ".go")
	name = strings.TrimSuffix(name, "_test")
	parts := strings.Split(name, "_")
	for i := len(parts) - 1; i >= 1 && i >= len(parts)-2; i-- {
		if knownPlatform[parts[i]] {
			ctx = append(ctx, "suffix:"+parts[i])
		}
	}
	return strings.Join(ctx, " && ")
}

var knownPlatform = map[string]bool{
	"windows": true, "darwin": true, "linux": true, "freebsd": true, "openbsd": true, "netbsd": true, "unix": false,
	"amd64": true, "arm64": true, "386": true, "arm": true, "wasm": true,
}
