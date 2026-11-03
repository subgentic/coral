package dataowner

import (
	"fmt"
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

// verdictBranchProblems is what is wrong with settleDataOwner's branch on the verdict: it must be exactly one `if v.Foreign` with no else, and its whole subtree (not only its direct statements: a nested
// if or switch could hide a return) must be straight-line: only calls to the WARN's log and the warning with its adopter, and no return, goto, break, continue, loop, switch, select, go or defer outside the
// adopter's own function literal (whose own returns are its own). #12651: a return nested in an inner if used to pass.
func verdictBranchProblems(fn *ast.FuncDecl) []string {
	var problems []string
	branches := 0
	var walk func(n ast.Node, inLit bool)
	walk = func(n ast.Node, inLit bool) {
		ast.Inspect(n, func(m ast.Node) bool {
			switch y := m.(type) {
			case *ast.FuncLit: // the adopter: its own returns are its own; everything else in it is still checked
				walk(y.Body, true)
				return false
			case *ast.ReturnStmt:
				if !inLit {
					problems = append(problems, "the verdict branch returns")
				}
			case *ast.BranchStmt:
				if !inLit {
					problems = append(problems, "the verdict branch has a "+y.Tok.String())
				}
			case *ast.IfStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt, *ast.ForStmt, *ast.RangeStmt, *ast.GoStmt, *ast.DeferStmt:
				if !inLit {
					problems = append(problems, fmt.Sprintf("the verdict branch is not straight-line (%T)", y))
				}
			case *ast.CallExpr:
				name := ""
				switch fx := y.Fun.(type) {
				case *ast.Ident:
					name = fx.Name
				case *ast.SelectorExpr:
					name = fx.Sel.Name
				}
				if name != "" && !allowedInWarn[name] {
					problems = append(problems, "the verdict branch calls "+name+": only the WARN and the warning belong there")
				}
			}
			return true
		})
	}
	for _, st := range fn.Body.List {
		ifs, ok := st.(*ast.IfStmt)
		if !ok {
			continue
		}
		cond, ok := ifs.Cond.(*ast.SelectorExpr)
		if !ok || cond.Sel.Name != "Foreign" {
			continue
		}
		branches++
		if ifs.Else != nil {
			problems = append(problems, "the verdict branch has an else: nothing differs for the other verdicts")
		}
		walk(ifs.Body, false)
	}
	// a branch on the verdict anywhere else in the function (nested, or in a closure) is another branch
	total := 0
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if ifs, ok := n.(*ast.IfStmt); ok {
			if cond, ok := ifs.Cond.(*ast.SelectorExpr); ok && cond.Sel.Name == "Foreign" {
				total++
			}
		}
		return true
	})
	if total != 1 || branches != 1 {
		problems = append(problems, fmt.Sprintf("exactly one branch on the verdict, at the top level of the function (found %d, %d at the top)", total, branches))
	}
	for _, st := range fn.Body.List { // and nothing returns early on the verdict
		if r, ok := st.(*ast.ReturnStmt); ok && len(r.Results) != 1 {
			problems = append(problems, "settleDataOwner returns the verdict and nothing else")
		}
	}
	sort.Strings(problems)
	return problems
}

func parseSettle(t *testing.T, src string) *ast.FuncDecl {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), "x.go", "package x\n"+src, 0)
	require.NoError(t, err)
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == "settleDataOwner" {
			return fd
		}
	}
	t.Fatal("no settleDataOwner in the source")
	return nil
}

// In settleDataOwner the one branch on the verdict logs the WARN and sets the warning, and nothing else, all the way down.
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
	assert.Empty(t, verdictBranchProblems(fn))
}

// The check sees every way the branch could skip the rest of the start, at any depth (#12651): a return in a nested if or switch, a goto, a loop, an else, a second branch, a call that is not the
// WARN or the warning; and it lets the real shape pass (the adopter's closure returns its own result).
func TestTheBranchCheckRejectsEveryWayToSkipTheRest(t *testing.T) {
	fn := func(body string) string {
		return "func settleDataOwner(ctx context.Context) dataowner.Verdict {\n\tv := verify(ctx)\n" + body + "\n\treturn v\n}\n"
	}
	warn := "log.Print(dataowner.LogLine(v)); dataowner.SetCopyWarning(dataowner.Notice, func(ctx context.Context) error { return AdoptDataDir(ctx) })"
	cases := map[string]struct{ src, want string }{
		"the real shape":                 {fn("\tif v.Foreign {\n" + warn + "\n\t}"), ""},
		"a return":                       {fn("\tif v.Foreign {\n" + warn + "\nreturn v\n\t}"), "returns"},
		"a return in a nested if":        {fn("\tif v.Foreign {\n" + warn + "\nif ctx.Err() != nil { return v }\n\t}"), "returns"},
		"a return in a nested switch":    {fn("\tif v.Foreign {\n" + warn + "\nswitch v.Reason { case \"x\": return v }\n\t}"), "returns"},
		"a return in a nested else":      {fn("\tif v.Foreign {\n" + warn + "\nif a { log.Print(1) } else { return v }\n\t}"), "returns"},
		"a nested if with only the WARN": {fn("\tif v.Foreign {\n" + warn + "\nif a { log.Print(1) }\n\t}"), "not straight-line"},
		"a nested switch":                {fn("\tif v.Foreign {\n" + warn + "\nswitch v.Reason { default: }\n\t}"), "not straight-line"},
		"a loop":                         {fn("\tif v.Foreign {\n" + warn + "\nfor { break }\n\t}"), "not straight-line"},
		"a goto":                         {fn("\tif v.Foreign {\n" + warn + "\ngoto end\n\t}\nend:"), "goto"},
		"a panic":                        {fn("\tif v.Foreign {\n" + warn + "\npanic(1)\n\t}"), "calls panic"},
		"an exit":                        {fn("\tif v.Foreign {\n" + warn + "\nos.Exit(1)\n\t}"), "calls Exit"},
		"a go statement":                 {fn("\tif v.Foreign {\n" + warn + "\ngo log.Print(1)\n\t}"), "not straight-line"},
		"a defer":                        {fn("\tif v.Foreign {\n" + warn + "\ndefer log.Print(1)\n\t}"), "not straight-line"},
		"an else":                        {fn("\tif v.Foreign {\n" + warn + "\n\t} else { log.Print(1) }"), "else"},
		"another call":                   {fn("\tif v.Foreign {\n" + warn + "\ntime.Sleep(1)\n\t}"), "calls Sleep"},
		"a second branch":                {fn("\tif v.Foreign {\n" + warn + "\n\t}\n\tif v.Foreign {\n log.Print(1)\n\t}"), "exactly one branch"},
		"a nested branch on the verdict": {fn("\tif v.Foreign {\n" + warn + "\nif v.Foreign { log.Print(1) }\n\t}"), "exactly one branch"},
		"control flow inside the adopter closure is its own": {fn("\tif v.Foreign {\n" + warn + "\nf := func() { if a { return } }\n\t}"), ""},
	}
	for name, c := range cases {
		got := strings.Join(verdictBranchProblems(parseSettle(t, c.src)), " | ")
		if c.want == "" {
			assert.Empty(t, got, name)
			continue
		}
		assert.Contains(t, got, c.want, name)
	}
}
