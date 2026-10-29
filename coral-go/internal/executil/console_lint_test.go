package executil

import (
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// A Coral with no console of its own (the tray's server, a scheduled task) gives every console program it starts a visible console window, unless the start says otherwise (#211, #383).
// In the updater and the routes that run it, and in the test helpers that start programs, a function that starts one with exec.Command / exec.CommandContext must also mention
// HideWindow, CREATE_NO_WINDOW or DETACHED_PROCESS (executil.Command does it itself). A start that needs none says why with a trailing "consoletest:allow <reason>" comment on its line.
// The agent CLI starts are checked by nocwd_lint_test.go; the other packages' product code is not in this list yet.
var consoleLintedDirs = []string{"server/routes", "updater", "linktest", "startup/locktest"}

func TestWindowsProgramStartsInTheUpdaterAndItsCallersAreHidden(t *testing.T) {
	ctxt := build.Default
	ctxt.GOOS = "windows"
	fset := token.NewFileSet()
	for _, rel := range consoleLintedDirs {
		root := filepath.Join("..", filepath.FromSlash(rel))
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			if ok, err := ctxt.MatchFile(filepath.Dir(path), d.Name()); err != nil || !ok {
				return nil // not compiled on Windows
			}
			f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
			if err != nil {
				return err
			}
			allowed := map[int]bool{}
			for _, cg := range f.Comments {
				for _, c := range cg.List {
					if strings.Contains(c.Text, "consoletest:allow ") {
						allowed[fset.Position(c.Pos()).Line] = true
					}
				}
			}
			for _, decl := range f.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				var starts []token.Pos
				hides := false
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					switch n := n.(type) {
					case *ast.CallExpr:
						if sel, ok := n.Fun.(*ast.SelectorExpr); ok {
							if x, ok := sel.X.(*ast.Ident); ok && x.Name == "exec" && (sel.Sel.Name == "Command" || sel.Sel.Name == "CommandContext") && !allowed[fset.Position(n.Pos()).Line] {
								starts = append(starts, n.Pos())
							}
						}
					case *ast.Ident:
						if n.Name == "HideWindow" || n.Name == "CREATE_NO_WINDOW" || n.Name == "DETACHED_PROCESS" {
							hides = true
						}
					case *ast.SelectorExpr:
						if n.Sel.Name == "HideWindow" || n.Sel.Name == "CREATE_NO_WINDOW" || n.Sel.Name == "DETACHED_PROCESS" {
							hides = true
						}
					}
					return true
				})
				if !hides {
					for _, p := range starts {
						t.Errorf("%s: %s starts a program with exec.Command and never hides its console window: executil.HideWindow(cmd), or executil.Command", fset.Position(p), fn.Name.Name)
					}
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
	}
}
