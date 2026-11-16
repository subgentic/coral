package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The flagcheck census (#17860). checkKnownFlags (flagcheck.go) refuses an option a command does not know, before the command runs. A test that calls a command's function directly skips it, so a new option
// worked in its test and the real CLI said 'unknown option --description' (#17560, #17586). This test reads the sources, not the CLI: for each command that has a table entry it collects every option-shaped
// string ("--name" or "-x" on its own) in the command's code, found from main.go's dispatch through the functions it calls in this package, and checks both ways against the table:
//  1. an option the command reads has an entry in the table (or is listed below with why it need not);
//  2. an entry in the table is read by the command (a stale entry would let a flag through that nothing reads).
//
// The unit is the command (all of a command's subcommands together: goal list and goal add are `goal`). A command with no table entry is free text and is not checked here.

var optionShape = regexp.MustCompile(`^--?[a-zA-Z][a-zA-Z0-9-]*$`)

// notChecked: options that appear in a command's code but are not options of the command as flagcheck sees them, each with why. Keyed by command, then option.
var notChecked = map[string]map[string]string{
	"resource": {"-local": "a suffix trimmed from a host name (strings.TrimSuffix in resource_setup.go), not an option"},
	"unlink":   {"--no-files": "cmdLink is shared with link; unlink answers --no-files itself, with its own message ('--no-files is for link: unlink removes the link whole')"},
}

// notRead: table entries the command's own code does not spell out as a literal, each with why.
var notRead = map[string]map[string]string{}

// source is this package's non-test, non-Windows files parsed: every function by name (a method by its name too), the dispatch switch of main.go and the table of flagcheck.go.
type source struct {
	funcs map[string]*ast.FuncDecl
	vars  map[string]map[string]bool // package-level variables that hold options: jsonOnly, noFlags
	main  *ast.FuncDecl
	check *ast.FuncDecl
}

func parseSource(t *testing.T) source {
	t.Helper()
	fset := token.NewFileSet()
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)
	src := source{funcs: map[string]*ast.FuncDecl{}, vars: map[string]map[string]bool{}}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || strings.HasSuffix(f, "_windows.go") {
			continue
		}
		af, err := parser.ParseFile(fset, f, nil, 0)
		require.NoError(t, err, f)
		for _, d := range af.Decls {
			if gd, ok := d.(*ast.GenDecl); ok && gd.Tok == token.VAR {
				for _, sp := range gd.Specs {
					if vs, ok := sp.(*ast.ValueSpec); ok {
						for i, id := range vs.Names {
							if i < len(vs.Values) {
								if o := options(vs.Values[i]); len(o) > 0 {
									src.vars[id.Name] = o
								}
							}
						}
					}
				}
				continue
			}
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			src.funcs[fd.Name.Name] = fd
			switch {
			case f == "main.go" && fd.Name.Name == "main":
				src.main = fd
			case f == "flagcheck.go" && fd.Name.Name == "checkKnownFlags":
				src.check = fd
			}
		}
	}
	require.NotNil(t, src.main)
	require.NotNil(t, src.check)
	return src
}

// flagDefiners are the FlagSet methods that define an option by its name, without the dashes, and the position of that name among the arguments.
var flagDefiners = map[string]int{"String": 0, "Bool": 0, "Int": 0, "Int64": 0, "Uint": 0, "Float64": 0, "Duration": 0, "StringVar": 1, "BoolVar": 1, "IntVar": 1, "DurationVar": 1, "Var": 1}

// definesFlags is true when n calls a FlagSet method that defines an option (String, Bool, ...).
func definesFlags(n ast.Node) bool {
	found := false
	ast.Inspect(n, func(x ast.Node) bool {
		if c, ok := x.(*ast.CallExpr); ok {
			if sel, ok := c.Fun.(*ast.SelectorExpr); ok {
				if _, ok := flagDefiners[sel.Sel.Name]; ok {
					found = true
				}
			}
		}
		return !found
	})
	return found
}

// options are the options under n: an option-shaped string literal ("--name", "-x"), and a name given to a FlagSet's String, Bool and the like, as "--name". The arguments of exec.Command are another
// program's options, not this command's.
func options(n ast.Node) map[string]bool {
	out := map[string]bool{}
	lit := func(e ast.Expr) (string, bool) {
		if bl, ok := e.(*ast.BasicLit); ok && bl.Kind == token.STRING {
			v, err := strconv.Unquote(bl.Value)
			return v, err == nil
		}
		return "", false
	}
	ast.Inspect(n, func(x ast.Node) bool {
		switch x := x.(type) {
		case *ast.CallExpr:
			if sel, ok := x.Fun.(*ast.SelectorExpr); ok {
				switch name := sel.Sel.Name; {
				case name == "Command" || name == "CommandContext":
					return false
				case len(x.Args) > flagDefiners[name] && strings.Contains(" String Bool Int Int64 Uint Float64 Duration StringVar BoolVar IntVar DurationVar Var ", " "+name+" "):
					if v, ok := lit(x.Args[flagDefiners[name]]); ok && regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]*$`).MatchString(v) {
						out["--"+v] = true
					}
				}
			}
		case *ast.RangeStmt: // for _, name := range []string{"title", "outcome"} { fs.String(name, ...) }: names given to a FlagSet from a list
			if cl, ok := x.X.(*ast.CompositeLit); ok && definesFlags(x.Body) {
				for _, el := range cl.Elts {
					if v, ok := lit(el); ok && regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]*$`).MatchString(v) {
						out["--"+v] = true
					}
				}
			}
		case *ast.BasicLit:
			if v, ok := lit(x); ok && optionShape.MatchString(v) {
				out[v] = true
			}
		}
		return true
	})
	return out
}

// withVars is options(n) plus those of the package-level option variables n refers to (jsonOnly, goalValueFlags).
func (s source) withVars(n ast.Node) map[string]bool {
	out := options(n)
	ast.Inspect(n, func(x ast.Node) bool {
		if id, ok := x.(*ast.Ident); ok {
			for o := range s.vars[id.Name] {
				out[o] = true
			}
		}
		return true
	})
	return out
}

// calls are the names of the functions called (or referred to) under n that are this package's own.
func (s source) calls(n ast.Node) []string {
	var out []string
	ast.Inspect(n, func(x ast.Node) bool {
		if id, ok := x.(*ast.Ident); ok {
			if _, ok := s.funcs[id.Name]; ok {
				out = append(out, id.Name)
			}
		}
		return true
	})
	return out
}

// reachable is every function reachable from the entry functions through the package's own calls.
func (s source) reachable(entries []string) []*ast.FuncDecl {
	seen := map[string]bool{}
	var out []*ast.FuncDecl
	queue := append([]string(nil), entries...)
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if seen[name] {
			continue
		}
		seen[name] = true
		fd := s.funcs[name]
		out = append(out, fd)
		queue = append(queue, s.calls(fd.Body)...)
	}
	return out
}

// caseNames are the command names of a switch clause: its string literals.
func caseNames(cc *ast.CaseClause) []string {
	var out []string
	for _, e := range cc.List {
		if bl, ok := e.(*ast.BasicLit); ok && bl.Kind == token.STRING {
			if v, err := strconv.Unquote(bl.Value); err == nil {
				out = append(out, v)
			}
		}
	}
	return out
}

// topSwitchCases are the clauses of the first `switch cmd` (a tag that is an identifier, not a call) at the top of fd.
func topSwitchCases(fd *ast.FuncDecl) []*ast.CaseClause {
	var out []*ast.CaseClause
	for _, st := range fd.Body.List {
		sw, ok := st.(*ast.SwitchStmt)
		if !ok {
			continue
		}
		if id, ok := sw.Tag.(*ast.Ident); !ok || id.Name != "cmd" {
			continue
		}
		for _, c := range sw.Body.List {
			out = append(out, c.(*ast.CaseClause))
		}
	}
	return out
}

// subSwitch is the `switch sub` under n, if there is one: a command with subcommands.
func subSwitch(n ast.Node) *ast.SwitchStmt {
	var found *ast.SwitchStmt
	ast.Inspect(n, func(x ast.Node) bool {
		if sw, ok := x.(*ast.SwitchStmt); ok && found == nil {
			if id, ok := sw.Tag.(*ast.Ident); ok && id.Name == "sub" {
				found = sw
				return false
			}
		}
		return true
	})
	return found
}

// helpOptions are read before flagcheck runs (main.go answers --help and -h for every command), so no table entry has them.
var helpOptions = map[string]bool{"--help": true, "-h": true}

func TestEveryOptionACommandReadsIsInTheFlagcheckTableAndBack(t *testing.T) {
	src := parseSource(t)
	// table: key is the command, or "command sub" when the table has an entry per subcommand (goal, task)
	table := map[string]map[string]bool{}
	for _, cc := range topSwitchCases(src.check) {
		for _, name := range caseNames(cc) {
			if sw := subSwitch(&ast.BlockStmt{List: cc.Body}); sw != nil {
				for _, c := range sw.Body.List {
					inner := c.(*ast.CaseClause)
					for _, sub := range caseNames(inner) {
						table[name+" "+sub] = src.withVars(inner)
					}
				}
				continue
			}
			table[name] = src.withVars(cc)
		}
	}
	require.Greater(t, len(table), 15, "the census must find the table's commands")
	require.Contains(t, table, "resource")
	require.Contains(t, table, "goal add")

	// entries: key -> the functions main.go calls for it, and the clause's own statements for a subcommand
	type entry struct {
		fns    []string
		bodies []ast.Node
	}
	entries := map[string]entry{}
	for _, cc := range topSwitchCases(src.main) {
		for _, name := range caseNames(cc) {
			e := entries[name]
			e.fns = append(e.fns, src.calls(&ast.BlockStmt{List: cc.Body})...)
			e.bodies = append(e.bodies, &ast.BlockStmt{List: cc.Body})
			entries[name] = e
			for _, fn := range e.fns { // a command with subcommands switches on `sub` in its own function
				if sw := subSwitch(src.funcs[fn].Body); sw != nil {
					for _, c := range sw.Body.List {
						inner := c.(*ast.CaseClause)
						for _, sub := range caseNames(inner) {
							entries[name+" "+sub] = entry{fns: src.calls(&ast.BlockStmt{List: inner.Body}), bodies: []ast.Node{&ast.BlockStmt{List: inner.Body}}}
						}
					}
				}
			}
		}
	}
	require.Contains(t, entries, "resource")
	require.Contains(t, entries, "goal add", "main.go's goal function switches on sub")

	keys := make([]string, 0, len(table))
	for k := range table {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		tbl := table[key]
		e, ok := entries[key]
		if !ok {
			t.Errorf("flagcheck.go has an entry for %q, which the code does not dispatch: remove it, or the census cannot read how it is dispatched", key)
			continue
		}
		used := map[string]bool{}
		for _, b := range e.bodies {
			for o := range src.withVars(b) {
				used[o] = true
			}
		}
		for _, fd := range src.reachable(e.fns) {
			for o := range src.withVars(fd.Body) {
				used[o] = true
			}
		}
		var missing, stale []string
		for o := range used {
			if _, why := notChecked[key][o]; !tbl[o] && !helpOptions[o] && !why {
				missing = append(missing, o)
			}
		}
		for o := range tbl {
			if _, why := notRead[key][o]; !used[o] && !why {
				stale = append(stale, o)
			}
		}
		sort.Strings(missing)
		sort.Strings(stale)
		assert.Empty(t, missing, "%q reads these options and flagcheck.go refuses them: add them to its table (the real CLI says 'unknown option'), or to notChecked here with why", key)
		assert.Empty(t, stale, "%q: flagcheck.go lists these options and the command's code never spells them out: remove the entry, or add it to notRead here with why", key)
	}
}

// The census found this one (#17860): `task detail N --version K` is the documented way to read an earlier version of a task, and the table refused --version. `task show` has no versions.
func TestTaskDetailTakesItsVersionOption(t *testing.T) {
	assert.NoError(t, checkKnownFlags([]string{"task", "detail", "5", "--version", "2"}))
	assert.NoError(t, checkKnownFlags([]string{"task", "show", "5", "--json"}))
	assert.Error(t, checkKnownFlags([]string{"task", "show", "5", "--version", "2"}), "show reads no version")
	assert.Error(t, checkKnownFlags([]string{"task", "detail", "5", "--versoin", "2"}), "a misspelt one is still refused")
}
