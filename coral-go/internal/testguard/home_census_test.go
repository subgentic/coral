package testguard

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Census (#413, Security's #6352): a test that reaches the person's home folder, ~/.coral or an agent CLI's folder (~/.codex, ~/.claude, ~/.gemini) must do it in a private home. A package's
// tests can be private three ways, and each is covered:
//   - the package's TestMain calls testtemp.Run or testtemp.Use, which points HOME, USERPROFILE and CORAL_DATA_DIR into a private folder for every test in it;
//   - the test file sets USERPROFILE (what os.UserHomeDir reads on Windows) itself, with t.Setenv or a setHome-style helper;
//   - or it never asks for the home folder at all.
//
// A _test.go file that names the home folder in none of the first two can stat, read or write the live folders, and fails here. It reads source, like the network census above: a home
// reached through another helper is not seen, but the common spelling is.
var homeReach = regexp.MustCompile(`os\.UserHomeDir\(|"\.(coral|codex|claude|gemini)"|\.(coral|codex|claude)[/\\]`)

// homeIsolated counts USERPROFILE only where it is SET (t.Setenv / os.Setenv): a mention in a comment or in a child's Env list does not make the test's own process private.
var homeIsolated = regexp.MustCompile(`Setenv\("USERPROFILE"|setHome\(|setTestHome\(`)
var privateWorld = regexp.MustCompile(`testtemp\.(Run|Use)\(`)

// homeViolations returns the files of one package (name -> source) that reach the home folder with neither a private world for the package nor a USERPROFILE of their own.
func homeViolations(files map[string]string) []string {
	private := false
	for _, src := range files {
		if privateWorld.MatchString(src) {
			private = true
		}
	}
	var bad []string
	for name, src := range files {
		if !private && homeReach.MatchString(src) && !homeIsolated.MatchString(src) {
			bad = append(bad, name)
		}
	}
	sort.Strings(bad)
	return bad
}

// The census fails on hand-built packages that reach the home folder unguarded, and passes the safe spellings.
func TestHomeCensusFailsOnAHandBuiltPath(t *testing.T) {
	reach := `func TestA(t *testing.T) { h, _ := os.UserHomeDir(); _ = filepath.Join(h, ".coral") }` + "\n"
	for name, tc := range map[string]struct {
		files map[string]string
		want  int
	}{
		"bare join":                   {map[string]string{"a_test.go": reach}, 1},
		"USERPROFILE only mentioned":  {map[string]string{"a_test.go": reach + "// USERPROFILE is read on Windows\n"}, 1},
		"only in a child's Env":       {map[string]string{"a_test.go": reach + `cmd.Env = []string{"USERPROFILE=" + h}` + "\n"}, 1},
		"codex folder":                {map[string]string{"a_test.go": `var _ = filepath.Join(h, ".codex")` + "\n"}, 1},
		"t.Setenv USERPROFILE":        {map[string]string{"a_test.go": reach + `t.Setenv("USERPROFILE", d)` + "\n"}, 0},
		"setHome helper":              {map[string]string{"a_test.go": reach + "setHome(t, d)\n"}, 0},
		"package TestMain is private": {map[string]string{"a_test.go": reach, "main_test.go": "func TestMain(m *testing.M) { os.Exit(testtemp.Run(m)) }\n"}, 0},
		"no home at all":              {map[string]string{"a_test.go": "package x\n"}, 0},
	} {
		if got := homeViolations(tc.files); len(got) != tc.want {
			t.Errorf("%s: %d violations %v, want %d", name, len(got), got, tc.want)
		}
	}
}

func TestEveryTestFileThatReachesTheHomeFolderRunsInAPrivateHome(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	pkgs := map[string]map[string]string{}
	for _, top := range []string{"internal", "cmd"} {
		_ = filepath.WalkDir(filepath.Join(root, top), func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, "_test.go") || filepath.Base(path) == "home_census_test.go" {
				return nil
			}
			b, rerr := os.ReadFile(path)
			if rerr != nil {
				return nil
			}
			dir := filepath.Dir(path)
			if pkgs[dir] == nil {
				pkgs[dir] = map[string]string{}
			}
			pkgs[dir][path] = string(b)
			return nil
		})
	}
	if len(pkgs) < 50 {
		t.Fatalf("the census found %d test packages under %s: the walk is not seeing the tree", len(pkgs), root)
	}
	for dir, files := range pkgs {
		if filepath.Base(dir) == "testtemp" && filepath.Base(filepath.Dir(dir)) == "internal" {
			continue // its tests call setup() themselves, which IS the private world they then assert on
		}
		for _, path := range homeViolations(files) {
			rel, _ := filepath.Rel(root, path)
			t.Errorf("%s names the home folder or an agent CLI's folder, %s has no TestMain that calls testtemp.Run/Use (a private HOME), and the file does not set USERPROFILE: it can reach the live "+
				"~/.coral (or ~/.codex, ~/.claude); give the package a testtemp TestMain or point the test at t.TempDir()", filepath.ToSlash(rel), filepath.ToSlash(dir))
		}
	}
}
