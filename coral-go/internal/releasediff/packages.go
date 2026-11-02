package releasediff

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// HubPackages are the packages Coral Hub compiles in (it imports them from this repository), so a change to their code is a change to the Hub's own binary, whatever the route table says (#12341:
// v2.0.35 changed pkg/hubproxy's UploadStallTimeout and the note did not name it). The list is fixed and written here, in one place; coral-hub confirms it, and a package that joins the Hub's
// imports is added to it.
var HubPackages = []string{
	"coral-go/pkg/hubproxy",
	"coral-go/pkg/hubowner",
	"coral-go/pkg/redact",
	"coral-go/pkg/secretbox",
	"coral-go/pkg/tunnel",
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

// PackageChange is one package's changed files, in path order.
type PackageChange struct {
	Package string
	Files   []FileChange
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

// GroupByPackage puts each changed file under the package of HubPackages whose directory holds it (a file in a sub-directory belongs to the package above it), in the order of HubPackages. A package
// with no change is still in the result, with no files, so the report can say it did not change.
func GroupByPackage(files []FileChange) []PackageChange {
	out := make([]PackageChange, len(HubPackages))
	for i, p := range HubPackages {
		out[i].Package = p
		for _, f := range files {
			if strings.HasPrefix(f.Path, p+"/") {
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

// WritePackages writes the Hub-compiled packages' changes as Markdown for the note: for each package that changed, the Go files the Hub compiles with their lines added and deleted, then one line
// for its test files and one for everything else (counts only: the Hub does not compile them); then the packages that did not change.
func WritePackages(w io.Writer, pcs []PackageChange, oldRef, newRef string) {
	fmt.Fprintf(w, "### Packages Coral Hub compiles in, %s to %s\n", oldRef, newRef)
	var same []string
	for _, pc := range pcs {
		short := strings.TrimPrefix(pc.Package, "coral-go/")
		if len(pc.Files) == 0 {
			same = append(same, "`"+short+"`")
			continue
		}
		var code, test, other []FileChange
		for _, f := range pc.Files {
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
		fmt.Fprintf(w, "\n`%s`: %s of Go code changed (+%d, -%d)\n\n", short, fileWord(len(code)), a, d)
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
