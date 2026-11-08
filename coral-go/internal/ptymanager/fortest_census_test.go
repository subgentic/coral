package ptymanager

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

// #359 (Security): a function named ...ForTest or ...ForTests exists so a test can shorten or fake something; no production file may call one. This reads every non-test Go file of the
// module and fails on a call to such a function (its own definition is not a call). The calls in _test.go files are what they are for.
func TestNoProductionFileCallsAForTestFunction(t *testing.T) {
	root := filepath.Join("..", "..")
	seen := 0
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", "vendor", ".git", "testdata", "static":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		f, perr := parser.ParseFile(token.NewFileSet(), path, src, 0)
		if perr != nil {
			return nil // a file with a build constraint the parser can't use is not this census's concern
		}
		seen++
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			name := ""
			switch fn := call.Fun.(type) {
			case *ast.Ident:
				name = fn.Name
			case *ast.SelectorExpr:
				name = fn.Sel.Name
			}
			if strings.HasSuffix(name, "ForTest") || strings.HasSuffix(name, "ForTests") {
				t.Errorf("%s calls %s: a ...ForTest function is for tests only", path, name)
			}
			return true
		})
		return nil
	})
	require.NoError(t, err)
	require.Greater(t, seen, 200, "the census read the module's Go files")
}
