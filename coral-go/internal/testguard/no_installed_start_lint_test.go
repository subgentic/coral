package testguard

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Census: no test starts a program from Program Files. A Windows machine that runs the tests usually has the person's own Coral installed there, and a
// test that started its coral-tray.exe put a second tray on their desktop, holding the live port (QA's ten extra trays, from a restart test that
// let the registry lookup stand). Every call that starts a program (exec.Command, exec.CommandContext, StartProcess) in a _test.go with a string
// literal naming "Program Files" anywhere in its arguments is refused. It reads the calls a test makes, so a path built from the registry or an
// environment variable is not seen: cmd/coral-update's TestMain is the guard for that one. An accident guard, not a proof.
var programStarts = map[string]bool{"Command": true, "CommandContext": true, "StartProcess": true}

// installedStartAllowed names "path:line"-free file entries with the reason a test may name Program Files in a start. Empty: none does.
var installedStartAllowed = map[string]string{}

func TestNoTestStartsAProgramFromProgramFiles(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	starts := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "vendor", "testdata":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		fset := token.NewFileSet()
		f, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			t.Errorf("%s: %v", rel, perr)
			return nil
		}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !programStarts[sel.Sel.Name] {
				return true
			}
			starts++
			for _, a := range call.Args {
				ast.Inspect(a, func(n ast.Node) bool {
					lit, ok := n.(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING {
						return true
					}
					if s, _ := strconv.Unquote(lit.Value); strings.Contains(strings.ToLower(s), "program files") && installedStartAllowed[rel] == "" {
						t.Errorf("%s:%d starts a program with %q: a test must not start anything from Program Files (the person's own Coral may be installed there); use a stub folder of the test's own", rel, fset.Position(call.Pos()).Line, s)
					}
					return true
				})
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if starts < 20 {
		t.Fatalf("the census found only %d program starts in the tests: it is looking at nothing", starts)
	}
}
