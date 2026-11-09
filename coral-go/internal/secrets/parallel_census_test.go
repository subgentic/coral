package secrets

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// #354: the heavy tests that only compute run in parallel with each other. Go runs the parallel tests after every sequential test of the package has finished, so the tests that measure
// time (the linearity guards) run alone first, on a quiet machine, and the ones below never run beside them. A test that measures time, changes the environment or swaps a package-level
// value must not be parallel: this fails when one is. The limit: it reads each test's own body only, so a parallel test that reaches the clock or the environment through a helper is
// not caught; a new helper that does either must not be called from a parallel test (the review's job, as the timing tests' being sequential is).
func TestNoParallelTestMeasuresTimeOrChangesTheEnvironment(t *testing.T) {
	files, err := filepath.Glob("*_test.go")
	require.NoError(t, err)
	parallel := 0
	for _, f := range files {
		src, err := os.ReadFile(f)
		require.NoError(t, err)
		af, err := parser.ParseFile(token.NewFileSet(), f, src, 0)
		require.NoError(t, err)
		for _, d := range af.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || !strings.HasPrefix(fn.Name.Name, "Test") || fn.Body == nil || fn.Name.Name == "TestNoParallelTestMeasuresTimeOrChangesTheEnvironment" { // not this census, which names the words
				continue
			}
			body := string(src[fn.Body.Pos()-1 : fn.Body.End()-1])
			if !strings.Contains(body, "t.Parallel()") {
				continue
			}
			parallel++
			for _, bad := range []string{"time.Since", "time.Now", "requireLinear", "Budget", "t.Setenv", "os.Setenv", "os.Unsetenv", "t.Chdir", "os.Chdir"} {
				require.NotContains(t, body, bad, "%s is parallel and uses %s: a test that measures time or changes the process must run alone", fn.Name.Name, bad)
			}
		}
	}
	require.Greater(t, parallel, 5, "the census sees the parallel tests")
}
