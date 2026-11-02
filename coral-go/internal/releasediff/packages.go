package releasediff

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// HubPath is one place in this repository that Coral Hub takes into its own binary: a Go package it compiles, or files it embeds (the shell's templates, scripts and styles, the agent docs).
type HubPath struct {
	Path     string // a directory, from the root of the repository
	Suffix   string // only the files of that directory itself that end so (the docs: ".md"); empty is the whole tree below it
	Embedded bool   // the Hub embeds the non-test files as they are, rather than compiling Go from them
}

// HubPaths is what Coral Hub compiles in or embeds (#12341: v2.0.35 changed pkg/hubproxy's UploadStallTimeout and the note did not name it). The list is fixed and written here, in one place; coral-hub
// confirmed it (pkg/frontend and the agent docs added at its asking, secretbox out: no other Hub package imports it, only internal/store does), and a path that joins the Hub's imports is added to it.
// Note that a package also compiles in the internal/ packages it imports (hubproxy: httputil, safego; hubowner: fsreplace, secfile; tunnel: safego): they are not listed here.
var HubPaths = []HubPath{
	{Path: "coral-go/pkg/hubproxy"},
	{Path: "coral-go/pkg/hubowner"},
	{Path: "coral-go/pkg/redact"},
	{Path: "coral-go/pkg/tunnel"},
	{Path: "coral-go/pkg/frontend", Embedded: true},
	{Path: "coral-go/agent_docs", Suffix: ".md", Embedded: true},
}

// pathspec is the git pathspec of the path, from the root of the repository whatever directory git runs in.
func (h HubPath) pathspec() string {
	if h.Suffix != "" {
		return ":(top,glob)" + h.Path + "/*" + h.Suffix
	}
	return ":(top)" + h.Path
}

// holds is whether a changed file is one of the path's.
func (h HubPath) holds(file string) bool {
	rest, ok := strings.CutPrefix(file, h.Path+"/")
	if !ok {
		return false
	}
	if h.Suffix != "" {
		return !strings.Contains(rest, "/") && strings.HasSuffix(rest, h.Suffix)
	}
	return true
}

// FileChange is one file that differs between two refs, with the lines added and deleted (Binary: git does not count a binary file's lines).
type FileChange struct {
	Path           string
	Added, Deleted int
	Binary         bool
}

// Kind says what the Hub does with the file: "code" is a Go file of the package that it compiles, "test" a _test.go file (not part of what it compiles), "other" anything else (data, docs, a golden).
func (f FileChange) Kind() string {
	switch {
	case strings.HasSuffix(f.Path, "_test.go"):
		return "test"
	case strings.HasSuffix(f.Path, ".go"):
		return "code"
	}
	return "other"
}

// PackageChange is one Hub path's changed files, in path order.
type PackageChange struct {
	Package  string
	Embedded bool
	Files    []FileChange
}

// ParseNumstat reads `git diff --numstat --no-renames -z` output: "added TAB deleted TAB path NUL" for each file ("-" for both counts is a binary file).
func ParseNumstat(b []byte) ([]FileChange, error) {
	var out []FileChange
	for _, rec := range strings.Split(string(b), "\x00") {
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\t", 3)
		if len(f) != 3 {
			return nil, fmt.Errorf("numstat record %q: want added, deleted and a path", rec)
		}
		fc := FileChange{Path: f[2]}
		if f[0] == "-" && f[1] == "-" {
			fc.Binary = true
		} else {
			a, err1 := strconv.Atoi(f[0])
			d, err2 := strconv.Atoi(f[1])
			if err1 != nil || err2 != nil {
				return nil, fmt.Errorf("numstat record %q: counts are not numbers", rec)
			}
			fc.Added, fc.Deleted = a, d
		}
		out = append(out, fc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// GroupByPackage puts each changed file under the path of HubPaths that holds it (a file in a sub-directory belongs to the package above it), in the order of HubPaths. A path with no change is still in
// the result, with no files, so the report can say it did not change.
func GroupByPackage(files []FileChange) []PackageChange {
	out := make([]PackageChange, len(HubPaths))
	for i, h := range HubPaths {
		out[i].Package, out[i].Embedded = h.Path, h.Embedded
		for _, f := range files {
			if h.holds(f.Path) {
				out[i].Files = append(out[i].Files, f)
			}
		}
	}
	return out
}

func totals(fs []FileChange) (a, d int) {
	for _, f := range fs {
		a, d = a+f.Added, d+f.Deleted
	}
	return
}

func fileWord(n int) string {
	if n == 1 {
		return "1 file"
	}
	return fmt.Sprintf("%d files", n)
}

// WritePackages writes the changes to what the Hub compiles in or embeds, as Markdown for the note: for each path that changed, the Go files it compiles (for an embedded path, every file it embeds) with their lines added and deleted, then one line
// for its test files and one for everything else (counts only: the Hub does not compile them); then the packages that did not change.
func WritePackages(w io.Writer, pcs []PackageChange, oldRef, newRef string) {
	fmt.Fprintf(w, "### What Coral Hub compiles in or embeds, %s to %s\n", oldRef, newRef)
	var same []string
	for _, pc := range pcs {
		short := strings.TrimPrefix(pc.Package, "coral-go/")
		if len(pc.Files) == 0 {
			same = append(same, "`"+short+"`")
			continue
		}
		var code, test, other []FileChange
		for _, f := range pc.Files {
			switch k := f.Kind(); {
			case k == "test":
				test = append(test, f)
			case k == "code" || pc.Embedded: // an embedded path's templates, scripts, styles and docs are what the Hub ships as they are
				code = append(code, f)
			default:
				other = append(other, f)
			}
		}
		a, d := totals(code)
		what := "of Go code"
		if pc.Embedded {
			what = "the Hub embeds"
		}
		fmt.Fprintf(w, "\n`%s`: %s %s changed (+%d, -%d)\n\n", short, fileWord(len(code)), what, a, d)
		for _, f := range code {
			fmt.Fprintf(w, "- `%s`: +%d, -%d\n", f.Path, f.Added, f.Deleted)
		}
		for _, g := range []struct {
			what string
			fs   []FileChange
		}{{"test", test}, {"other", other}} {
			if len(g.fs) == 0 {
				continue
			}
			a, d := totals(g.fs)
			label := "test files, not compiled by the Hub"
			if g.what == "other" {
				label = "other files (data, docs), not compiled by the Hub"
			}
			fmt.Fprintf(w, "- %s: %s (+%d, -%d)\n", label, fileWord(len(g.fs)), a, d)
		}
	}
	if len(same) == len(pcs) {
		fmt.Fprintln(w, "\nNo file changed in any of them: "+strings.Join(same, ", ")+".")
		return
	}
	if len(same) > 0 {
		fmt.Fprintln(w, "\nUnchanged: "+strings.Join(same, ", ")+".")
	}
}
