package netbindtest

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// A test may listen only on loopback unless it asks this package first (the console lint's way: a census of the source). Every call that
// opens a listening socket in a _test.go file is read: a Unix socket, or an address literal that starts with 127., [::1], ::1 or localhost,
// is loopback; any other call (a wildcard, a network address, a host taken from a variable) is "open", and its file must import this
// package, or be named in loopbackByConstruction with the reason its address is loopback.
var listenCalls = map[string]int{ // the function names that listen, and the position of the address argument
	"Listen": -1, "ListenTCP": -1, "ListenUDP": -1, "ListenPacket": -1, "ListenIP": -1, "listenTCP": 0, "listenAll": -2,
}

// loopbackByConstruction: files whose open listens are on an address that is loopback by how the test makes it.
var loopbackByConstruction = map[string]string{
	"internal/background/remote_agents_test.go":     "newListener re-listens on the address of an httptest server (127.0.0.1)",
	"internal/hooks/listener_owner_windows_test.go": "ranges over the literals 127.0.0.1:0 and [::1]:0",
	"internal/server/hub_e2e_test.go":               "starts the hub again on the address of its first httptest listener (127.0.0.1)",
	"internal/server/routes/update_check_test.go":   "listens again on an httptest server's address (127.0.0.1)",
	"internal/serverproof/proof_test.go":            "takes the address of its own httptest server (127.0.0.1)",
	"internal/startup/listener_census_test.go":      "the privacy gate rewrites every host to loopback before listenAll; the test asserts that every socket is loopback",
	"pkg/tunnel/loopback_dial_test.go":              "listens again on the 127.0.0.1 address it just closed",
	"internal/peercred/peercred_linux_test.go":      "its table's addresses are all 127.0.0.1 and ::1 literals",
}

func TestATestListensOnlyOnLoopbackUnlessItAsksFirst(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	open := map[string][]string{} // file -> the open calls
	asks := map[string]bool{}
	seen := 0
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
		for _, imp := range f.Imports {
			if strings.HasSuffix(strings.Trim(imp.Path.Value, `"`), "/internal/netbindtest") {
				asks[rel] = true
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			var name string
			switch fn := call.Fun.(type) {
			case *ast.SelectorExpr:
				name = fn.Sel.Name
			case *ast.Ident:
				name = fn.Name
			}
			pos, listens := listenCalls[name]
			if !listens {
				return true
			}
			// A method named Listen on something that is not a listener factory takes other arguments: only the shapes below count.
			if name == "Listen" && len(call.Args) != 2 && len(call.Args) != 3 {
				return true
			}
			seen++
			if !loopbackCall(call, name, pos) {
				open[rel] = append(open[rel], strconv.Itoa(fset.Position(call.Pos()).Line))
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen < 20 {
		t.Fatalf("the census found only %d listening calls in the tests: it is looking at nothing", seen)
	}
	var files []string
	for f := range open {
		files = append(files, f)
	}
	sort.Strings(files)
	for _, f := range files {
		if !asks[f] && loopbackByConstruction[f] == "" {
			t.Errorf("%s listens on an address that is not provably loopback (%d call(s)): call netbindtest.Require before it (a Windows Firewall prompt on the desktop), or, if the address is loopback by construction, name the file in loopbackByConstruction with the reason", f, len(open[f]))
		}
	}
	for f, why := range loopbackByConstruction {
		if why == "" {
			t.Errorf("%s: loopbackByConstruction needs a reason", f)
		}
		if _, ok := open[f]; !ok {
			t.Errorf("%s is named in loopbackByConstruction but has no open listen call: remove it", f)
		}
		if asks[f] {
			t.Errorf("%s asks netbindtest and is also in loopbackByConstruction: one of them", f)
		}
	}
}

// loopbackCall reports whether a listening call's address is a Unix socket or a loopback literal. pos is the address argument's index, or
// -1 for the last argument.
func loopbackCall(call *ast.CallExpr, name string, pos int) bool {
	if name == "listenAll" {
		return false // takes a Config: its Host decides
	}
	if len(call.Args) > 0 {
		if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
			if s, _ := strconv.Unquote(lit.Value); strings.HasPrefix(s, "unix") {
				return true
			}
		}
	}
	var arg ast.Expr
	if pos >= 0 {
		if pos < len(call.Args) {
			arg = call.Args[pos]
		}
	} else if len(call.Args) > 0 {
		arg = call.Args[len(call.Args)-1] // net.Listen(network, addr) and lc.Listen(ctx, network, addr): the last
	}
	return isLoopbackLiteral(arg)
}

func isLoopbackLiteral(e ast.Expr) bool {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind != token.STRING {
			return false
		}
		s, err := strconv.Unquote(v.Value)
		if err != nil {
			return false
		}
		for _, p := range []string{"127.", "[::1]", "::1", "localhost"} {
			if strings.HasPrefix(s, p) {
				return true
			}
		}
	case *ast.BinaryExpr: // "127.0.0.1:" + port
		return v.Op == token.ADD && isLoopbackLiteral(v.X)
	case *ast.CallExpr: // net.JoinHostPort("127.0.0.1", ...)
		if sel, ok := v.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "JoinHostPort" && len(v.Args) > 0 {
			return isLoopbackLiteral(v.Args[0])
		}
	}
	return false
}
