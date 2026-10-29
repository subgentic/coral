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
// In the updater and the routes that run it, and in the test helpers that start programs, each program started with exec.Command / exec.CommandContext must be assigned to a variable that the same function hides: HideWindow(cmd), or
// cmd.SysProcAttr set with HideWindow, CREATE_NO_WINDOW or DETACHED_PROCESS (executil.Command does it itself). A start that needs none says why with a trailing "consoletest:allow <reason>" comment on its line.
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
				hidden := map[string]bool{}         // the command variables this function hides
				bound := map[*ast.CallExpr]string{} // exec calls assigned to a variable, by that variable
				var starts []*ast.CallExpr
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					switch n := n.(type) {
					case *ast.CallExpr:
						if isExecStart(n) && !allowed[fset.Position(n.Pos()).Line] {
							starts = append(starts, n)
						}
						if calledName(n) == "HideWindow" && len(n.Args) == 1 { // HideWindow(cmd), executil.HideWindow(cmd)
							if v, ok := n.Args[0].(*ast.Ident); ok {
								hidden[v.Name] = true
							}
						}
					case *ast.AssignStmt:
						for i, lhs := range n.Lhs {
							if i < len(n.Rhs) {
								if c, ok := n.Rhs[i].(*ast.CallExpr); ok && isExecStart(c) {
									if v, ok := lhs.(*ast.Ident); ok {
										bound[c] = v.Name
									}
								}
							}
							// cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: ... DETACHED_PROCESS / CREATE_NO_WINDOW, or HideWindow: true}
							if v := sysProcAttrOwner(lhs); v != "" && mentionsNoWindow(n.Rhs) {
								hidden[v] = true
							}
						}
					}
					return true
				})
				for _, c := range starts {
					if v := bound[c]; v == "" {
						t.Errorf("%s: %s starts a program with exec.Command that is not assigned to a variable, so its console window cannot be hidden: assign it and executil.HideWindow it, or use executil.Command", fset.Position(c.Pos()), fn.Name.Name)
					} else if !hidden[v] {
						t.Errorf("%s: %s starts %s with exec.Command and never hides its console window: executil.HideWindow(%s), or executil.Command", fset.Position(c.Pos()), fn.Name.Name, v, v)
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

func isExecStart(c *ast.CallExpr) bool {
	sel, ok := c.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	x, ok := sel.X.(*ast.Ident)
	return ok && x.Name == "exec" && (sel.Sel.Name == "Command" || sel.Sel.Name == "CommandContext")
}

// calledName is the name of the function a call calls: f(...) or pkg.f(...).
func calledName(c *ast.CallExpr) string {
	switch f := c.Fun.(type) {
	case *ast.Ident:
		return f.Name
	case *ast.SelectorExpr:
		return f.Sel.Name
	}
	return ""
}

// sysProcAttrOwner is "cmd" for the left side cmd.SysProcAttr or cmd.SysProcAttr.CreationFlags.
func sysProcAttrOwner(e ast.Expr) string {
	var sawAttr bool
	for {
		sel, ok := e.(*ast.SelectorExpr)
		if !ok {
			break
		}
		if sel.Sel.Name == "SysProcAttr" {
			sawAttr = true
		}
		e = sel.X
	}
	if id, ok := e.(*ast.Ident); ok && sawAttr {
		return id.Name
	}
	return ""
}

// mentionsNoWindow: the expressions name HideWindow, CREATE_NO_WINDOW or DETACHED_PROCESS (as a field, a constant or windows.CREATE_NO_WINDOW).
func mentionsNoWindow(exprs []ast.Expr) bool {
	found := false
	for _, e := range exprs {
		ast.Inspect(e, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.Ident:
				found = found || n.Name == "HideWindow" || n.Name == "CREATE_NO_WINDOW" || n.Name == "DETACHED_PROCESS"
			case *ast.SelectorExpr:
				found = found || n.Sel.Name == "CREATE_NO_WINDOW" || n.Sel.Name == "DETACHED_PROCESS"
			}
			return true
		})
	}
	return found
}
