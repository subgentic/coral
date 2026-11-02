package releasediff

import (
	"bytes"
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/subgentic/coral/internal/gitutil"
)

// Reader reads the files of one ref of a repository with git; it runs nothing of the ref.
type Reader struct{ Repo, Ref string }

func (r Reader) git(args ...string) ([]byte, error) {
	cmd := gitutil.Command(context.Background(), r.Repo, args...) // a repository's own config can name commands for git to run: every git Coral starts goes through gitutil.Command
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}

// File is the content of path at the ref.
func (r Reader) File(path string) ([]byte, error) { return r.git("show", r.Ref+":"+path) }

// Routes reads the route census of the ref.
func (r Reader) Routes() (Entries, error) {
	cloud, err := r.File(CloudRoutesPath)
	if err != nil {
		return nil, err
	}
	owner, err := r.File(OwnerRoutesPath)
	if err != nil {
		return nil, err
	}
	return ParseRoutes(cloud, owner)
}

// Settings reads the board settings keys of the ref from the Go files of internal/board (test files left out).
func (r Reader) Settings() (Entries, error) {
	list, err := r.git("ls-tree", "--full-tree", "--name-only", r.Ref, BoardDir)
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for _, p := range strings.Fields(string(list)) {
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			continue
		}
		b, err := r.File(p)
		if err != nil {
			return nil, err
		}
		files[p] = b
	}
	return ParseSettings(files)
}

// Resolve checks that a ref names a commit, so a typo is one clear line and not a failed read of a file.
func Resolve(repo, ref string) (string, error) {
	if strings.HasPrefix(ref, "-") { // a leading dash would be read by git as an option, not as a ref
		return "", fmt.Errorf("%q is not a commit, tag or branch of %s", ref, repo)
	}
	out, err := Reader{Repo: repo}.git("rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("%q is not a commit, tag or branch of %s", ref, repo)
	}
	return strings.TrimSpace(string(out)), nil
}

// PackageChanges is the files of HubPaths that differ between two refs, read with `git diff --numstat --no-renames -z` (read only: nothing of either ref is run). A rename shows as a delete and an add.
func PackageChanges(repo, oldRef, newRef string) ([]PackageChange, error) {
	args := []string{"diff", "--numstat", "--no-renames", "-z", oldRef, newRef, "--"}
	for _, h := range HubPaths {
		args = append(args, h.pathspec()) // from the root of the repository, whatever directory -repo names (git's pathspecs are relative to it)
	}
	out, err := Reader{Repo: repo}.git(args...)
	if err != nil {
		return nil, err
	}
	files, err := ParseNumstat(out)
	if err != nil {
		return nil, err
	}
	return GroupByPackage(files), nil
}

// DirImports are the module's packages that the non-test Go files directly in dir import at the ref (a directory that is not there imports none).
func (r Reader) DirImports(dir, module string) ([]string, error) {
	list, err := r.git("ls-tree", "--full-tree", "--name-only", r.Ref, dir+"/")
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for _, p := range strings.Fields(string(list)) {
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			continue
		}
		b, err := r.File(p)
		if err != nil {
			return nil, err
		}
		files[p] = b
	}
	return ImportedDirs(files, module)
}

// HubClosure is the module's packages the Hub's Go packages (HubPaths that are not just files) compile in at the ref: their imports, followed through each other.
func (r Reader) HubClosure() ([]Dep, error) {
	gomod, err := r.File(ModuleRoot + "go.mod")
	if err != nil {
		return nil, err
	}
	module, err := ModulePath(gomod)
	if err != nil {
		return nil, err
	}
	return Closure(hubGoRoots(), func(dir string) ([]string, error) { return r.DirImports(dir, module) })
}

// hubGoRoots are the directories of HubPaths that are Go packages (not the docs, which are only files).
func hubGoRoots() []string {
	var roots []string
	for _, h := range HubPaths {
		if h.Suffix == "" {
			roots = append(roots, h.Path)
		}
	}
	return roots
}

// DependencyChanges is what changed between two refs in the module packages the Hub compiles in through its imports (the roots, listed by their own section, left out): read with go/parser and one
// `git diff --numstat` over the packages' own directories (the files directly in each: a package is its directory's files). Nothing of either ref is built or run.
func DependencyChanges(repo, oldRef, newRef string) ([]DepChange, error) {
	oc, err := Reader{Repo: repo, Ref: oldRef}.HubClosure()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", oldRef, err)
	}
	nc, err := Reader{Repo: repo, Ref: newRef}.HubClosure()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", newRef, err)
	}
	roots := hubGoRoots()
	seen := map[string]bool{}
	args := []string{"diff", "--numstat", "--no-renames", "-z", oldRef, newRef, "--"}
	for _, c := range [][]Dep{oc, nc} {
		for _, d := range c {
			if !seen[d.Dir] && !slices.Contains(roots, d.Dir) {
				seen[d.Dir] = true
				args = append(args, ":(top,glob)"+d.Dir+"/*") // the files directly in the directory, from the root of the repository
			}
		}
	}
	var files []FileChange
	if len(args) > 7 {
		out, err := Reader{Repo: repo}.git(args...)
		if err != nil {
			return nil, err
		}
		if files, err = ParseNumstat(out); err != nil {
			return nil, err
		}
	}
	return CompareClosures(oc, nc, roots, files), nil
}
