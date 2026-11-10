package config

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// A -X linker flag whose package path is wrong is silently ignored: the build succeeds and Version, PostHogKey and DevBase come out empty, so a
// release would call itself a development build and send no events. The module was renamed (#5539), so this test reads every script, workflow and
// Makefile that sets one and requires that the package path is THIS package's real import path and that the variable exists. A new build script
// with a stale path fails here, not in production.

type probe struct{}

// thisPackage is this package's import path as the linker knows it.
func thisPackage() string { return reflect.TypeOf(probe{}).PkgPath() }

// xFlag matches "-X path.Var=": the linker's name for a string variable.
var xFlag = regexp.MustCompile(`-X[ =]+"?([^\s"=]+)\.([A-Za-z_][A-Za-z0-9_]*)=`)

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if fi, err := os.Stat(filepath.Join(dir, ".github", "workflows")); err == nil && fi.IsDir() {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip(".github/workflows not found above the working directory (a source tree without the repository around it)")
		}
		dir = parent
	}
}

// stringVars are the package-level string variables of this package: the only things a -X flag into it may set.
func stringVars(t *testing.T) map[string]bool { return stringVarsIn(t, ".") }

// stringVarsIn is stringVars for the package in one folder.
func stringVarsIn(t *testing.T, dir string) map[string]bool {
	t.Helper()
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, dir, func(fi fs.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, 0)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, p := range pkgs {
		for _, f := range p.Files {
			for _, d := range f.Decls {
				g, ok := d.(*ast.GenDecl)
				if !ok || g.Tok != token.VAR {
					continue
				}
				for _, s := range g.Specs {
					vs := s.(*ast.ValueSpec)
					if id, ok := vs.Type.(*ast.Ident); ok && id.Name == "string" {
						for _, n := range vs.Names {
							out[n.Name] = true
						}
					} else if vs.Type == nil {
						// var X = "literal": untyped, a string all the same, and the linker sets it
						for i, n := range vs.Names {
							if i < len(vs.Values) {
								if lit, ok := vs.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
									out[n.Name] = true
								}
							}
						}
					}
				}
			}
		}
	}
	return out
}

// buildFiles are the places that set linker flags: scripts, workflows and the Makefile, by directory, so a new script is found without a list.
func buildFiles(t *testing.T, root string) []string {
	t.Helper()
	var files []string
	for _, dir := range []string{".github", "installers", "tools", "tests", "coral-go/Makefile"} {
		p := filepath.Join(root, filepath.FromSlash(dir))
		_ = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if d.Name() == "node_modules" || d.Name() == ".git" {
					return filepath.SkipDir
				}
				return nil
			}
			switch strings.ToLower(filepath.Ext(path)) {
			case ".sh", ".yml", ".yaml", ".ps1", ".py", "":
				files = append(files, path)
			}
			return nil
		})
	}
	sort.Strings(files)
	return files
}

// Files that hold a stale flag ON PURPOSE: the build check's control, a wrong path that must come out ignored.
var staleOnPurpose = map[string]bool{
	"tests/release/ldflags_build_test.sh": true,
}

// Programs that are not Coral and set their own variable: a flag naming main.<var> is allowed only in these files.
var mainVarAllowed = map[string]string{
	"tests/release/update_rehearsal.sh": "version", // the updater test rig's unhealthy-coral stand-in (internal/updater/testrig/cmd/unhealthy-coral)
}

// Build variables of OTHER packages a release stamps on purpose, by import path (relative to this module's internal/) then folder: each flag into one
// must name one of the listed variables, and the variable must exist as a string in that folder's package (#15065, the Dropbox app key).
var otherPackageVars = map[string]struct {
	dir  string
	vars []string
}{
	"server/routes": {dir: "../server/routes", vars: []string{"DropboxDefaultAppKey"}},
}

func TestEveryLinkerFlagNamesThisPackageAndARealVariable(t *testing.T) {
	root := repoRoot(t)
	want := thisPackage()
	vars := stringVars(t)
	for _, v := range []string{"Version", "PostHogKey", "DevBase"} {
		if !vars[v] {
			t.Fatalf("config has no string variable %s: the build scripts set it", v)
		}
	}
	perFile := map[string]int{}
	perOther := map[string]int{}
	for _, f := range buildFiles(t, root) {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		rel, _ := filepath.Rel(root, f)
		rel = filepath.ToSlash(rel)
		if staleOnPurpose[rel] {
			continue
		}
		for _, m := range xFlag.FindAllStringSubmatch(string(b), -1) {
			pkg, name := m[1], m[2]
			switch {
			case pkg == "main":
				if mainVarAllowed[rel] != name {
					t.Errorf("%s: -X main.%s sets a variable of whatever program is built (cmd/coral has none): use %s.%s", rel, name, want, name)
				}
			case otherPackageFlag(t, want, pkg, name):
				perOther[rel]++
			case pkg != want:
				t.Errorf("%s: -X %s.%s names a package that is not %s: the linker ignores it silently and the build comes out with an empty %s", rel, pkg, name, want, name)
			case !vars[name]:
				t.Errorf("%s: -X %s.%s names a variable that does not exist (or is not a string)", rel, pkg, name)
			default:
				perFile[rel]++
			}
		}
	}
	// A floor, so a scanner that stopped finding the flags cannot pass: every script that bakes the version in is counted.
	for _, rel := range []string{
		".github/workflows/release.yml",
		".github/workflows/linux-runner-dryrun.yml",
		"installers/build-macos.sh",
		"installers/build-linux.sh",
		"tools/build_windows.ps1",
		"coral-go/Makefile",
		"tests/release/update_rehearsal.sh",
	} {
		if perFile[rel] == 0 && rel != "tests/release/update_rehearsal.sh" {
			t.Errorf("%s: no linker flag into %s was found: the scan is blind, or the script no longer sets the version", rel, want)
		}
	}
	if got := perFile[".github/workflows/release.yml"]; got < 8 {
		t.Errorf("release.yml sets %d flags into config, want at least 8 (PostHogKey and Version in four builds)", got)
	}
	if got := perOther[".github/workflows/release.yml"]; got < 4 {
		t.Errorf("release.yml sets %d Dropbox app key flags, want 4 (Linux, Windows, macOS arm64 and amd64)", got)
	}
}

// otherPackageFlag says whether "-X pkg.name" is one of the allowed variables of another package, and fails the test when that variable is gone.
func otherPackageFlag(t *testing.T, want, pkg, name string) bool {
	t.Helper()
	module := strings.TrimSuffix(want, "/internal/config")
	for suffix, o := range otherPackageVars {
		if pkg != module+"/internal/"+suffix {
			continue
		}
		listed := false
		for _, v := range o.vars {
			listed = listed || v == name
		}
		if !listed {
			return false
		}
		if !stringVarsIn(t, o.dir)[name] {
			t.Errorf("-X %s.%s names a variable that does not exist (or is not a string) in %s", pkg, name, o.dir)
		}
		return true
	}
	return false
}

// The scanner itself: a stale path and a missing variable are found, a right one is not.
func TestTheLinkerFlagScannerSeesWrongPaths(t *testing.T) {
	good := `LDFLAGS="-s -w -X ` + thisPackage() + `.Version=1"`
	stale := `LDFLAGS="-s -w -X github.com/cdknorow/coral/internal/config.Version=1"`
	for _, tc := range []struct {
		text    string
		wantPkg string
	}{{good, thisPackage()}, {stale, "github.com/cdknorow/coral/internal/config"}} {
		m := xFlag.FindStringSubmatch(tc.text)
		if m == nil || m[1] != tc.wantPkg || m[2] != "Version" {
			t.Fatalf("%q: scanner found %v", tc.text, m)
		}
	}
	if thisPackage() == "github.com/cdknorow/coral/internal/config" {
		t.Fatal("the module path is still the old one: this test would bless the old flags")
	}
}
