package testguard

import (
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
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			var fn string
			switch c := call.Fun.(type) {
			case *ast.SelectorExpr:
				fn = c.Sel.Name
			case *ast.Ident:
				fn = c.Name
			}
			switch {
			case fn == "NewLazySystemDLL":
				safe++
			case bareDLLLoads[fn] && knownDLLs[firstString(call)]:
				// a KnownDLL by its literal name: the loader maps it from the system folder
			case bareDLLLoads[fn] && allowedLibrary(dir) && strings.Contains(filepath.ToSlash(dir), "mattn/go-isatty@"):
				calls++
				t.Errorf("%s:%d loads %q by a bare name: go-isatty is allowed only kernel32.dll and ntdll.dll", filepath.Join(dir, name), fset.Position(call.Pos()).Line, firstString(call))
			case bareDLLLoads[fn] && allowedLibrary(dir):
				// the loader itself
			case bareDLLLoads[fn]:
				calls++
				t.Errorf("%s:%d loads a DLL by a bare name (%s): use windows.NewLazySystemDLL", filepath.Join(dir, name), fset.Position(call.Pos()).Line, fn)
			}
			return true
		})
	}
	return calls, safe
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
