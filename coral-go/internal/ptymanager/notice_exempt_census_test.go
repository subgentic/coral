package ptymanager

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// No production backend may opt out of the notice check (#389): NoticeCheckNotApplicable is the marker of a test fake (NoticeCheckExempt), so a non-test file defining it would let a real
// terminal or runtime type board notices without proving that the foreground is the agent. The interface declaring it is fine; a method is not.
func TestNoProductionFileDefinesNoticeCheckNotApplicable(t *testing.T) {
	root := filepath.Join("..", "..") // coral-go
	fset := token.NewFileSet()
	var found []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" || n == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			return nil // a file that does not parse is another test's finding
		}
		for _, decl := range f.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == "NoticeCheckNotApplicable" {
				found = append(found, fset.Position(fn.Pos()).String())
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) > 0 {
		t.Errorf("a production file defines NoticeCheckNotApplicable, which only test fakes may: %s", strings.Join(found, ", "))
	}
}
