package consoletest

import (
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lintedPackages are the packages (under internal/) whose Windows test files must not call exec.Command or exec.CommandContext directly: a console program started that way opens
// a console window on the desktop (#382). They use consoletest.HiddenCommand, or executil.Command / executil.HideWindow where consoletest would be an import cycle (executil).
// ptymanager has its own lint (#381).
var lintedPackages = []string{"agent", "background", "config", "executil", "psquote", "safefs", "secfile", "server/routes"}

func TestWindowsTestsStartConsoleProgramsHidden(t *testing.T) {
	ctxt := build.Default
	ctxt.GOOS = "windows"
	fset := token.NewFileSet()
	for _, pkg := range lintedPackages {
		dir := filepath.Join("..", filepath.FromSlash(pkg))
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("%s: %v", pkg, err)
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || !strings.HasSuffix(name, "_test.go") {
				continue
			}
			if ok, err := ctxt.MatchFile(dir, name); err != nil || !ok {
				continue // not compiled on Windows
			}
			f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, 0)
			if err != nil {
				t.Fatalf("%s/%s: %v", pkg, name, err)
			}
			execName := ""
			for _, imp := range f.Imports {
				if imp.Path.Value == `"os/exec"` {
					execName = "exec"
					if imp.Name != nil {
						execName = imp.Name.Name
					}
				}
			}
			if execName == "" {
				continue
			}
			allowed := map[int]bool{} // lines with a "consoletest:allow <reason>" comment, and the line below it
			for _, cg := range f.Comments {
				for _, c := range cg.List {
					if strings.Contains(c.Text, "consoletest:allow ") {
						line := fset.Position(c.Pos()).Line
						allowed[line], allowed[line+1] = true, true
					}
				}
			}
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if x, ok := sel.X.(*ast.Ident); ok && x.Name == execName && (sel.Sel.Name == "Command" || sel.Sel.Name == "CommandContext") && !allowed[fset.Position(call.Pos()).Line] {
					t.Errorf("%s: exec.%s in a Windows test file opens a console window: use consoletest.HiddenCommand (or executil.Command / executil.HideWindow)", fset.Position(call.Pos()), sel.Sel.Name)
				}
				return true
			})
		}
	}
}
