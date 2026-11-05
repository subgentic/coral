package testtemp

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13745: no test makes a folder inside the source tree. Source-walking tests of other packages (the store's scan for session-token writes, the route census) list the tree while
// `go test -p 4` runs every package at once; a folder one package's test made in its own source folder (routes' nativehome-NNN) could be gone by the time a walker opened it:
// 'open ../server/routes/nativehome-NNN: no such file', twice (1cb04915a, de34687c4), each time "fixed" by making a walker skip what vanished.
//
// This reads every _test.go file in the module and checks the folder argument of each os.MkdirTemp(dir, pattern): it must be "" (the temp folder), t.TempDir(), os.TempDir(), or a place in
// the table below, each with its reason. A new MkdirTemp(here, ...) (a folder from filepath.Abs(".") or a relative one) is not in the table, so it fails here, and the message says what to use
// (testtemp.OutsideTemp for a folder that must not be under the temp folder, t.TempDir() for the rest).
var mkdirTempBases = map[string]string{
	`""`:              "the temp folder",
	`t.TempDir()`:     "a test's own folder",
	`os.TempDir()`:    "the temp folder",
	`"/tmp"`:          "a short path: sockets and ptys have a length limit",
	`shortTempBase()`: "a short path for sockets and ptys (routes)",
	`privateBase()`:   "testtemp's own private base (its tests)",
}

// per file: the one-off bases that are variables of the test itself (a folder the test made under the temp folder).
var mkdirTempFileBases = map[string]map[string]string{
	"internal/foldertrust/foldertrust_test.go":      {"real": "a folder the test made under the temp folder"},
	"internal/server/strict_local_auth_e2e_test.go": {"dir": "the test's own data folder"},
	"internal/testtemp/socket_room_test.go":         {"tmp": "the test's temp folder"},
	"internal/testtemp/owner_windows_test.go":       {"parent": "the test's own folder"},
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	require.NoError(t, err)
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d
		}
		require.NotEqual(t, d, filepath.Dir(d), "no go.mod above %s", dir)
	}
}

func TestNoTestMakesAFolderInsideTheSourceTree(t *testing.T) {
	root := moduleRoot(t)
	fset := token.NewFileSet()
	var bad []string
	seen := 0
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // a folder another package's test removed while this walked
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" || strings.HasPrefix(n, "nativehome-") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, "_test.go") {
			return nil
		}
		f, perr := parser.ParseFile(fset, p, nil, 0)
		if perr != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		ast.Inspect(f, func(n ast.Node) bool {
			c, ok := n.(*ast.CallExpr)
			if !ok || len(c.Args) < 2 {
				return true
			}
			sel, ok := c.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "MkdirTemp" {
				return true
			}
			if x, ok := sel.X.(*ast.Ident); !ok || x.Name != "os" {
				return true
			}
			seen++
			var buf bytes.Buffer
			_ = printer.Fprint(&buf, fset, c.Args[0])
			arg := buf.String()
			if _, ok := mkdirTempBases[arg]; ok {
				return true
			}
			if _, ok := mkdirTempFileBases[rel][arg]; ok {
				return true
			}
			bad = append(bad, rel+": os.MkdirTemp("+arg+", ...) at "+fset.Position(c.Pos()).String())
			return true
		})
		return nil
	})
	require.NoError(t, err)
	require.Greater(t, seen, 10, "the census read the module's tests (it saw %d MkdirTemp calls)", seen)
	sort.Strings(bad)
	assert.Empty(t, bad, "a test must not make a folder inside the source tree: use t.TempDir(), or testtemp.OutsideTemp(t) for a folder that must not be under the temp folder (#13745); a base that is really elsewhere goes in the table with its reason")
}
