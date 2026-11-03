package dataowner

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12591, #12603: Coral never blocks on the data-folder check. The verdict is read in one place (internal/startup/startup_dataowner.go, settleDataOwner), where a copy only logs one WARN and sets the
// warning the dashboard shows; nothing else in the program may branch on it, and nothing may ask whether "this Coral is foreign" (the flag and its gates are gone: v2.0.37 withheld every agent's delivery,
// wake and sleep from the operator's own folder, and the rule is that an upgrade can never do that). A new check of a verdict anywhere else fails here.
//
// What this reads: every non-test .go file under cmd, internal and pkg, as syntax, never running it.
//   - no identifier named SetForeign, RefuseIfForeign, ErrForeign or IsForeign, and no call to a function named Foreign;
//   - a selector `.Foreign` (the Verdict's field) only inside internal/dataowner itself and settleDataOwner;
//   - dataowner.Verify or dataowner.Verdict only in settleDataOwner's file;
//   - inside settleDataOwner, the `if v.Foreign` body calls nothing but the WARN log, the warning and its adopter.
const settleFile = "internal/startup/startup_dataowner.go"

var forbiddenNames = map[string]bool{"SetForeign": true, "RefuseIfForeign": true, "ErrForeign": true, "IsForeign": true}

// allowedInWarn are the calls the one `if v.Foreign` body may make: the log, and the warning with its adopter.
var allowedInWarn = map[string]bool{"Print": true, "LogLine": true, "SetCopyWarning": true, "AdoptDataDir": true}

func censusFiles(t *testing.T) map[string]*ast.File {
	t.Helper()
	root := filepath.Join("..", "..")
	out := map[string]*ast.File{}
	fset := token.NewFileSet()
	for _, top := range []string{"cmd", "internal", "pkg"} {
		require.NoError(t, filepath.WalkDir(filepath.Join(root, top), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() && (d.Name() == "testdata" || d.Name() == "node_modules") {
				return fs.SkipDir
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			f, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				return nil // a file that does not parse is not this census's to judge
			}
			rel, _ := filepath.Rel(root, path)
			out[filepath.ToSlash(rel)] = f
			return nil
		}))
	}
	require.Greater(t, len(out), 500, "the census read the program")
	return out
}

func TestNothingBranchesOnADataFolderVerdictButTheOneWarning(t *testing.T) {
	var problems []string
	for rel, f := range censusFiles(t) {
		inDataowner := strings.HasPrefix(rel, "internal/dataowner/")
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.Ident:
				if forbiddenNames[x.Name] {
					problems = append(problems, rel+": "+x.Name)
				}
			case *ast.SelectorExpr:
				switch {
				case x.Sel.Name == "Foreign" && !inDataowner && rel != settleFile:
					problems = append(problems, rel+": .Foreign read outside settleDataOwner")
				case !inDataowner && rel != settleFile && isDataownerSel(x, "Verify", "Verdict"):
					problems = append(problems, rel+": dataowner."+x.Sel.Name+" outside settleDataOwner")
				}
			case *ast.CallExpr:
				if id, ok := x.Fun.(*ast.Ident); ok && id.Name == "Foreign" {
					problems = append(problems, rel+": a call to Foreign()")
				}
				if sel, ok := x.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Foreign" {
					problems = append(problems, rel+": a call to .Foreign()")
				}
			}
			return true
		})
	}
	sort.Strings(problems)
	assert.Empty(t, problems, "nothing may branch on a data-folder verdict or ask whether this Coral is foreign: the check only warns (#12591)")
}

func isDataownerSel(x *ast.SelectorExpr, names ...string) bool {
	id, ok := x.X.(*ast.Ident)
	if !ok || id.Name != "dataowner" {
		return false
	}
	for _, n := range names {
		if x.Sel.Name == n {
			return true
		}
	}
	return false
}

// In settleDataOwner the one branch on the verdict logs the WARN and sets the warning, and nothing else: no return, no skipped step, no call that could withhold anything.
func TestTheOneBranchOnTheVerdictOnlyWarns(t *testing.T) {
	f := censusFiles(t)[settleFile]
	require.NotNil(t, f, settleFile)
	var fn *ast.FuncDecl
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == "settleDataOwner" {
			fn = fd
		}
	}
	require.NotNil(t, fn, "settleDataOwner")
	branches := 0
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		ifs, ok := n.(*ast.IfStmt)
		if !ok {
			return true
		}
		cond, ok := ifs.Cond.(*ast.SelectorExpr)
		if !ok || cond.Sel.Name != "Foreign" {
			return true
		}
		branches++
		assert.Nil(t, ifs.Else, "no else: nothing differs for the other verdicts")
		checkCalls := func(body ast.Node) {
			ast.Inspect(body, func(m ast.Node) bool {
				switch y := m.(type) {
				case *ast.FuncLit: // the adopter: its own returns are its own; its calls are still checked
					return true
				case *ast.ReturnStmt:
					_ = y
				case *ast.CallExpr:
					name := ""
					switch fx := y.Fun.(type) {
					case *ast.Ident:
						name = fx.Name
					case *ast.SelectorExpr:
						name = fx.Sel.Name
					}
					if name != "" && !allowedInWarn[name] {
						t.Errorf("the verdict branch calls %s: only the WARN and the warning belong there", name)
					}
				}
				return true
			})
		}
		checkCalls(ifs.Body)
		for _, st := range ifs.Body.List { // a return directly in the branch would skip the rest of the start: none
			if _, isRet := st.(*ast.ReturnStmt); isRet {
				t.Errorf("the verdict branch must not return")
			}
		}
		return true
	})
	assert.Equal(t, 1, branches, "exactly one branch on the verdict")
	for _, s := range fn.Body.List { // and nothing after it returns early on the verdict
		if r, ok := s.(*ast.ReturnStmt); ok {
			assert.Len(t, r.Results, 1, "settleDataOwner returns the verdict and nothing else")
		}
	}
}
