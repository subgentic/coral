package fsreplace

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestNoBareRename: an os.Rename onto an existing file fails on Windows while a reader has it open (#9738), so every non-test rename in the module goes through fsreplace.Rename. A new bare os.Rename
// fails here; a rename that cannot meet an open destination (a name that is fresh by construction) still goes through Rename, which costs nothing when the first try works.
func TestNoBareRename(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	require.NoError(t, err)
	fset := token.NewFileSet()
	var bare []string
	require.NoError(t, filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" || n == "testdata" {
				return filepath.SkipDir
			}
			if _, err := os.Stat(filepath.Join(path, "go.mod")); err == nil && path != root {
				return filepath.SkipDir // a module of its own (tools/coral-agents-token) cannot import internal/
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || filepath.Dir(path) == filepath.Join(root, "internal", "fsreplace") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		osName := "" // the local name of the "os" import
		for _, imp := range f.Imports {
			if imp.Path.Value == `"os"` {
				osName = "os"
				if imp.Name != nil {
					osName = imp.Name.Name
				}
			}
		}
		if osName == "" || osName == "_" || osName == "." {
			return nil
		}
		ast.Inspect(f, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Rename" {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == osName {
				rel, _ := filepath.Rel(root, path)
				bare = append(bare, fset.Position(sel.Pos()).String()[len(path)-len(rel):])
			}
			return true
		})
		return nil
	}))
	require.Empty(t, bare, "use fsreplace.Rename instead of os.Rename (a reader holding the destination fails os.Rename on Windows, #9738)")
}
