package testguard

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// #13783 (Security): golang.org/x/crypto/openpgp is unmaintained and unsafe by design (govulncheck GO-2026-5932, whose fix is not in a release). Nothing here imports it, so the finding is unreached: this keeps it so. A source
// scan over every Go file of the module (tests included): an import of golang.org/x/crypto/openpgp or of anything under it fails, so an ordinary change cannot reach a finding the dependency bump is waiting on. The
// machine launcher uses golang.org/x/crypto/ssh only.
func TestNothingImportsTheUnmaintainedOpenPGPPackages(t *testing.T) {
	root := filepath.Join("..", "..") // the module root: coral-go
	fset := token.NewFileSet()
	var found []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // a directory that vanished while the walk ran (a test's temporary folder)
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "testdata", "vendor":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		f, perr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if perr != nil {
			return nil // a file the scan cannot read is not an import; the build catches a broken one
		}
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			if p == "golang.org/x/crypto/openpgp" || strings.HasPrefix(p, "golang.org/x/crypto/openpgp/") {
				found = append(found, filepath.ToSlash(path)+" imports "+p)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) > 0 {
		t.Errorf("golang.org/x/crypto/openpgp is unmaintained and unsafe by design (GO-2026-5932, no fixed release): do not import it. Use golang.org/x/crypto/ssh or a maintained package. Found: %v", found)
	}
}

// The scan itself must be able to see an import (a scan that finds nothing in a file that has one would pass for ever).
func TestTheOpenPGPScanSeesAnImport(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "x.go", "package x\nimport _ \"golang.org/x/crypto/openpgp/armor\"\n", parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Imports) != 1 || !strings.HasPrefix(strings.Trim(f.Imports[0].Path.Value, `"`), "golang.org/x/crypto/openpgp/") {
		t.Fatalf("the scan's own parse did not see the import: %+v", f.Imports)
	}
}
