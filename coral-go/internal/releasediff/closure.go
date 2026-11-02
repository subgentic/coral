package releasediff

import (
	"fmt"
	"go/parser"
	"go/token"
	"io"
	"sort"
	"strconv"
	"strings"
)

// The Coral packages the Hub's own packages import, directly and through each other, are compiled into the Hub binary too (#12344: v2.0.35 changed pkg/hubproxy, which takes internal/httputil and
// internal/safego with it, and a change in internal/secfile or internal/fsreplace is the kind that matters to the Hub's security). This follows the imports the way `go list -deps` does, but by
// reading them: go/parser over the non-test Go files of each package at the ref, nothing built or run. Build constraints are not evaluated, so a file for another system counts: the set is a
// little wider than one build's, never narrower.

// ModulePath is this repository's Go module, read from go.mod at the ref.
func ModulePath(gomod []byte) (string, error) {
	for _, l := range strings.Split(string(gomod), "\n") {
		if m, ok := strings.CutPrefix(strings.TrimSpace(l), "module "); ok {
			return strings.Trim(strings.TrimSpace(m), `"`), nil
		}
	}
	return "", fmt.Errorf("go.mod has no module line")
}

// ImportedDirs are the directories (from the repository root, with the coral-go/ prefix) of the module's own packages that the Go files import. A file that does not parse is an error: a silent skip
// would leave a dependency out of the note.
func ImportedDirs(files map[string][]byte, module string) ([]string, error) {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	seen := map[string]bool{}
	fset := token.NewFileSet()
	for _, n := range names {
		f, err := parser.ParseFile(fset, n, files[n], parser.ImportsOnly)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", n, err)
		}
		for _, im := range f.Imports {
			path, err := strconv.Unquote(im.Path.Value)
			if err != nil {
				return nil, fmt.Errorf("%s: import %s: %w", n, im.Path.Value, err)
			}
			if rest, ok := strings.CutPrefix(path, module+"/"); ok {
				if !plainDir(rest) {
					return nil, fmt.Errorf("%s: import %q is not a plain package path of the module", n, path)
				}
				seen[ModuleRoot+rest] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Strings(out)
	return out, nil
}

// plainDir is whether the rest of an import path, after the module's own prefix, is a plain relative directory: segments that are not empty and not "..", with no glob character and no colon, so that
// it cannot widen a git pathspec or name anything outside coral-go/ when it is given to ls-tree, show and the diff (go build rejects such a path, but this reads files without building them).
func plainDir(rest string) bool {
	if rest == "" || strings.ContainsAny(rest, "*?[:\\") {
		return false
	}
	for _, seg := range strings.Split(rest, "/") {
		if seg == "" || seg == ".." || seg == "." {
			return false
		}
	}
	return true
}

// ModuleRoot is the module's directory in the repository.
const ModuleRoot = "coral-go/"

// Closure follows the imports from the root directories: every package of the module they reach, each with the package that first reached it ("" for a root), in the order they were found.
// dirImports gives the module packages one directory imports (an absent directory imports none).
func Closure(roots []string, dirImports func(dir string) ([]string, error)) ([]Dep, error) {
	var out []Dep
	seen := map[string]bool{}
	queue := []string{}
	for _, r := range roots {
		if !seen[r] {
			seen[r] = true
			out = append(out, Dep{Dir: r})
			queue = append(queue, r)
		}
	}
	for len(queue) > 0 {
		d := queue[0]
		queue = queue[1:]
		ims, err := dirImports(d)
		if err != nil {
			return nil, err
		}
		for _, im := range ims {
			if !seen[im] {
				seen[im] = true
				out = append(out, Dep{Dir: im, Via: d})
				queue = append(queue, im)
			}
		}
	}
	return out, nil
}

// Dep is a package of the module in the Hub's closure and the package that first imports it.
type Dep struct{ Dir, Via string }

// DepChange is one dependency's changed files (the files of its own directory: a package is that directory's Go files), and whether it entered or left the Hub's imports between the refs.
type DepChange struct {
	Dir    string
	Via    string // the package that imports it, at the new ref (at the old one when it left)
	Joined bool   // in the new closure only
	Left   bool   // in the old closure only
	Files  []FileChange
}

// CompareClosures merges the two refs' closures and the changed files of the packages in either, leaving out the roots (listed by their own section). files are the changes of the packages' own
// directories, from DependencyFiles.
func CompareClosures(oldC, newC []Dep, roots []string, files []FileChange) []DepChange {
	isRoot := map[string]bool{}
	for _, r := range roots {
		isRoot[r] = true
	}
	byDir := map[string]*DepChange{}
	add := func(c []Dep, mark func(*DepChange)) {
		for _, d := range c {
			if isRoot[d.Dir] {
				continue
			}
			dc, ok := byDir[d.Dir]
			if !ok {
				dc = &DepChange{Dir: d.Dir, Via: d.Via}
				byDir[d.Dir] = dc
			}
			mark(dc)
		}
	}
	add(oldC, func(dc *DepChange) { dc.Left = true })
	add(newC, func(dc *DepChange) { dc.Via = viaIn(newC, dc.Dir); dc.Left = false; dc.Joined = !inDeps(oldC, dc.Dir) })
	var out []DepChange
	for _, dc := range byDir {
		for _, f := range files {
			if strings.HasPrefix(f.Path, dc.Dir+"/") && !strings.Contains(strings.TrimPrefix(f.Path, dc.Dir+"/"), "/") {
				dc.Files = append(dc.Files, f)
			}
		}
		out = append(out, *dc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Dir < out[j].Dir })
	return out
}

func inDeps(c []Dep, dir string) bool {
	for _, d := range c {
		if d.Dir == dir {
			return true
		}
	}
	return false
}

func viaIn(c []Dep, dir string) string {
	for _, d := range c {
		if d.Dir == dir {
			return d.Via
		}
	}
	return ""
}

// WriteDependencies writes the dependencies' changes as Markdown for the note: each package that changed, with its Go files and lines (its tests and other files as counts), who imports it, and whether
// it joined or left the Hub's imports; then the ones that did not change.
func WriteDependencies(w io.Writer, dcs []DepChange, oldRef, newRef string) {
	fmt.Fprintf(w, "### Coral packages compiled into the Hub through its imports, %s to %s\n", oldRef, newRef)
	short := func(d string) string { return strings.TrimPrefix(d, ModuleRoot) }
	var same []string
	for _, dc := range dcs {
		note := ""
		switch {
		case dc.Joined:
			note = ", new in the Hub's imports"
		case dc.Left:
			note = ", no longer in the Hub's imports"
		}
		if len(dc.Files) == 0 && note == "" {
			same = append(same, "`"+short(dc.Dir)+"`")
			continue
		}
		var code, test, other []FileChange
		for _, f := range dc.Files {
			switch f.Kind() {
			case "code":
				code = append(code, f)
			case "test":
				test = append(test, f)
			default:
				other = append(other, f)
			}
		}
		a, d := totals(code)
		via := ""
		if dc.Via != "" {
			via = ", imported by `" + short(dc.Via) + "`"
		}
		fmt.Fprintf(w, "\n`%s`: %s of Go code changed (+%d, -%d)%s%s\n\n", short(dc.Dir), fileWord(len(code)), a, d, via, note)
		for _, f := range code {
			fmt.Fprintf(w, "- `%s`: +%d, -%d\n", f.Path, f.Added, f.Deleted)
		}
		for _, g := range []struct {
			label string
			fs    []FileChange
		}{{"test files, not compiled by the Hub", test}, {"other files, not compiled by the Hub", other}} {
			if len(g.fs) == 0 {
				continue
			}
			a, d := totals(g.fs)
			fmt.Fprintf(w, "- %s: %s (+%d, -%d)\n", g.label, fileWord(len(g.fs)), a, d)
		}
	}
	if len(dcs) == 0 {
		fmt.Fprintln(w, "\nThe Hub's packages import nothing else from this module.")
		return
	}
	if len(same) > 0 {
		fmt.Fprintln(w, "\nUnchanged: "+strings.Join(same, ", ")+".")
	}
}
