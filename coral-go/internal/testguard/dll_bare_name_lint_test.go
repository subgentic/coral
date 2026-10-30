package testguard

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Census: no program loads a DLL by a bare name. A bare name is searched for in the folder the program runs from before the system folder, and the updater runs from a copy in a folder
// the user can write to (<data>/updates/apply), so a DLL planted beside it would run inside a program that decides what Windows Installer replaces. windows.NewLazySystemDLL loads from
// the system folder only; NewLazyDLL, LoadDLL, MustLoadDLL and LoadLibrary* do not. Every non-test Go file of the repository is read, and, with go list, every non-standard package
// that coral-update links on Windows (a library's own bare load is as much a planted DLL's way in). Standard-library loads are the Go team's own (they use the system folder).
// An accident guard: it reads calls, not what a library does at run time; cmd/coral-update's dll_windows.go is the process-wide lock behind it.
var bareDLLLoads = map[string]bool{"NewLazyDLL": true, "LoadDLL": true, "MustLoadDLL": true, "LoadLibrary": true, "LoadLibraryW": true, "LoadLibraryA": true, "LoadLibraryEx": true, "LoadLibraryExW": true}

// bareDLLAllowed names the libraries that may spell a bare-name load, by a part of their folder, with the reason. Only these two, and only for what they do today:
//   - golang.org/x/sys/windows IS the loader windows.NewLazySystemDLL is built on (its LoadDLL and LoadLibraryEx calls carry the system-folder flag when System is set);
//   - mattn/go-isatty loads kernel32.dll and ntdll.dll: KnownDLLs, which the loader maps from the system folder whatever the search path says (a file planted beside the
//     program cannot replace them). The census below checks that these are the only names it loads.
var bareDLLAllowed = map[string]string{
	"golang.org/x/sys@": "the loader windows.NewLazySystemDLL is built on",
	"mattn/go-isatty@":  "kernel32.dll and ntdll.dll, KnownDLLs",
}

// knownDLLs are the names a bare load may spell, anywhere: the loader takes them from the system folder (KnownDLLs).
var knownDLLs = map[string]bool{"kernel32.dll": true, "ntdll.dll": true}

func allowedLibrary(dir string) bool {
	d := filepath.ToSlash(dir)
	for part := range bareDLLAllowed {
		if strings.Contains(d, part) {
			return true
		}
	}
	return false
}

// firstString is the string literal a call's first argument spells, "" when it is not one.
func firstString(call *ast.CallExpr) string {
	if len(call.Args) == 0 {
		return ""
	}
	if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
		if v, err := strconv.Unquote(lit.Value); err == nil {
			return strings.ToLower(v)
		}
	}
	return ""
}

// bareDLLFindings reads one parsed file and returns what it does wrong, and how many system-folder loads (NewLazySystemDLL) it makes. Besides a call of a bare-name loader it
// catches a LazyDLL built by hand (a struct literal) and a bare-name loader used as a VALUE (stored, passed or returned without being called), which a call-only census misses.
func bareDLLFindings(fset *token.FileSet, f *ast.File, dir, name string) (findings []string, safe int) {
	at := func(n ast.Node) string {
		return fmt.Sprintf("%s:%d", filepath.Join(dir, name), fset.Position(n.Pos()).Line)
	}
	library := allowedLibrary(dir)
	isatty := strings.Contains(filepath.ToSlash(dir), "mattn/go-isatty@")
	called := map[ast.Node]bool{}   // the Fun of every call
	declared := map[ast.Node]bool{} // names that are not a use of their own: a declared function, the name after a dot
	ast.Inspect(f, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.CallExpr:
			called[v.Fun] = true
		case *ast.FuncDecl:
			declared[v.Name] = true
		case *ast.SelectorExpr:
			declared[v.Sel] = true // the name after a dot is judged with its selector, not on its own
		}
		return true
	})
	ast.Inspect(f, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.CallExpr:
			var fn string
			switch c := v.Fun.(type) {
			case *ast.SelectorExpr:
				fn = c.Sel.Name
			case *ast.Ident:
				fn = c.Name
			}
			switch {
			case fn == "NewLazySystemDLL":
				safe++
			case bareDLLLoads[fn] && knownDLLs[firstString(v)]:
				// a KnownDLL by its literal name: the loader maps it from the system folder
			case bareDLLLoads[fn] && library && isatty:
				findings = append(findings, fmt.Sprintf("%s loads %q by a bare name: go-isatty is allowed only kernel32.dll and ntdll.dll", at(v), firstString(v)))
			case bareDLLLoads[fn] && library:
				// the loader itself
			case bareDLLLoads[fn]:
				findings = append(findings, fmt.Sprintf("%s loads a DLL by a bare name (%s): use windows.NewLazySystemDLL", at(v), fn))
			}
		case *ast.CompositeLit:
			var tn string
			switch ty := v.Type.(type) {
			case *ast.SelectorExpr:
				tn = ty.Sel.Name
			case *ast.Ident:
				tn = ty.Name
			}
			if tn == "LazyDLL" && !library {
				findings = append(findings, fmt.Sprintf("%s builds a LazyDLL by hand (a bare-name load): use windows.NewLazySystemDLL", at(v)))
			}
		case *ast.SelectorExpr:
			if bareDLLLoads[v.Sel.Name] && !called[v] && !library {
				findings = append(findings, fmt.Sprintf("%s uses %s as a value: a bare-name loader must not be stored or passed (use windows.NewLazySystemDLL)", at(v), v.Sel.Name))
			}
		case *ast.Ident:
			if bareDLLLoads[v.Name] && !called[v] && !declared[v] && !library {
				findings = append(findings, fmt.Sprintf("%s uses %s as a value: a bare-name loader must not be stored or passed (use windows.NewLazySystemDLL)", at(v), v.Name))
			}
		}
		return true
	})
	return findings, safe
}

func scanBareDLLLoads(t *testing.T, dir string) (calls, safe int) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		f, perr := parser.ParseFile(fset, filepath.Join(dir, name), nil, 0)
		if perr != nil {
			continue
		}
		findings, s := bareDLLFindings(fset, f, dir, name)
		safe += s
		for _, msg := range findings {
			calls++
			t.Error(msg)
		}
	}
	return calls, safe
}

// The scanner on source text: a call, a hand-built LazyDLL and a loader used as a value are each found, a system-folder load and a KnownDLL are not.
func TestTheCensusCatchesALazyDLLLiteralAndALoaderUsedAsAValue(t *testing.T) {
	find := func(src string) []string {
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, "x.go", src, 0)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := bareDLLFindings(fset, f, "repo/pkg", "x.go")
		return got
	}
	for name, src := range map[string]string{
		"a call":                          `package p; import "syscall"; var d = syscall.NewLazyDLL("version.dll")`,
		"a LazyDLL literal":               `package p; import "syscall"; var d = &syscall.LazyDLL{Name: "version.dll"}`,
		"a bare literal of the type":      `package p; type LazyDLL struct{ Name string }; var d = LazyDLL{Name: "version.dll"}`,
		"NewLazyDLL stored as a value":    `package p; import "syscall"; var load = syscall.NewLazyDLL`,
		"LoadDLL passed as a value":       `package p; import "syscall"; func use(f func(string) (*syscall.DLL, error)) {}; func g() { use(syscall.LoadDLL) }`,
		"LoadLibrary returned as a value": `package p; import "syscall"; func g() func(string) (uintptr, error) { return syscall.LoadLibrary }`,
	} {
		assert.NotEmpty(t, find(src), name)
	}
	for name, src := range map[string]string{
		"a system-folder load":     `package p; import "golang.org/x/sys/windows"; var d = windows.NewLazySystemDLL("version.dll")`,
		"a KnownDLL by its name":   `package p; import "syscall"; var d = syscall.NewLazyDLL("kernel32.dll")`,
		"a function named LoadDLL": `package p; func LoadDLL(name string) {}`,
	} {
		assert.Empty(t, find(src), name)
	}
}

func TestNoProgramLoadsADLLByABareName(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	safe := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "vendor", "testdata":
				return filepath.SkipDir
			}
			_, s := scanBareDLLLoads(t, p)
			safe += s
		}
		return nil
	})
	if safe < 3 {
		t.Fatalf("the census found only %d system-folder loads in the repository: it is looking at nothing", safe)
	}
}

// The libraries coral-update links on Windows, read the same way.
func TestNoLibraryCoralUpdateLinksLoadsADLLByABareName(t *testing.T) {
	if testing.Short() {
		t.Skip("runs go list over the program")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "list", "-deps", "-f", "{{if not .Standard}}{{.Dir}}{{end}}", "./cmd/coral-update")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list: %v", err)
	}
	dirs := strings.Fields(strings.ReplaceAll(string(out), "\r", ""))
	if len(dirs) < 100 {
		t.Fatalf("go list named only %d packages: the census looked at nothing", len(dirs))
	}
	sawSys := false
	for _, d := range dirs {
		if strings.Contains(filepath.ToSlash(d), "golang.org/x/sys@") {
			sawSys = true
		}
		scanBareDLLLoads(t, d)
	}
	if !sawSys {
		t.Fatal("golang.org/x/sys is not among coral-update's packages: the census looked at the wrong graph")
	}
	b, err := os.ReadFile(filepath.Join(root, "cmd", "coral-update", "dll_windows.go"))
	if err != nil || !strings.Contains(string(b), "SetDefaultDllDirectories(windows.LOAD_LIBRARY_SEARCH_SYSTEM32)") {
		t.Fatal("cmd/coral-update/dll_windows.go no longer locks the process's DLL search to the system folder")
	}
}
