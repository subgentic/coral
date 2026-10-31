package frontend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every esbuild build in this package runs from esbuildRoot, a root with no folder above it, not from the process's working folder: only build
// calls api.Build, and the root is absolute and its own parent.
func TestEveryEsbuildBuildRunsFromTheFixedRoot(t *testing.T) {
	if !filepath.IsAbs(esbuildRoot) || filepath.Dir(esbuildRoot) != esbuildRoot {
		t.Fatalf("esbuildRoot %q is not a root", esbuildRoot)
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		n := strings.Count(string(b), "api.Build(")
		if want := map[bool]int{true: 1, false: 0}[f == "esbuild.go"]; n != want {
			t.Errorf("%s calls api.Build %d times, want %d: a build goes through build(), which sets AbsWorkingDir", f, n, want)
		}
	}
}
