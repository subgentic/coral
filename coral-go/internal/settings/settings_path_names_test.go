package settings

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Every "Settings > X" a person reads in a Go string or an agent doc names a real Settings section (#17165, the Go follow-up of #15986): the nav's section titles (data-title in the dashboard's
// modals.html) are the truth, so a renamed section cannot leave a CLI message, a log line or a doc pointing at the old one. String literals are read through the Go parser, so a code comment that
// still says "Settings > Run as a hub" is not a message and is not counted.
var settingsPath = regexp.MustCompile(`\bSettings\s*(?:>|›|→|&gt;)\s*([A-Z][^"\n` + "`" + `]{0,60})`)

func sectionTitles(t *testing.T, root string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "pkg/frontend/templates/includes/modals.html"))
	if err != nil {
		t.Skip("no dashboard template beside this module")
	}
	var out []string
	for _, m := range regexp.MustCompile(`id="settings-pane-[a-z-]+"[^>]*data-title="([^"]*)"`).FindAllStringSubmatch(string(b), -1) {
		out = append(out, m[1])
	}
	if len(out) < 8 {
		t.Fatalf("found only %d section titles in modals.html: %v", len(out), out)
	}
	return out
}

func namesARealSection(titles []string, after string) bool {
	for _, title := range titles {
		if strings.HasPrefix(after, title) {
			return true
		}
	}
	return false
}

func TestSettingsPathsInGoStringsAndAgentDocsNameRealSections(t *testing.T) {
	root := "../.."
	titles := sectionTitles(t, root)
	var bad []string
	check := func(where, text string) {
		for _, m := range settingsPath.FindAllStringSubmatch(text, -1) {
			if !namesARealSection(titles, m[1]) && !strings.HasPrefix(m[1], "Camera") { // Camera is iOS's own Settings app (uploads.go)
				bad = append(bad, where+": Settings > "+strings.TrimSpace(m[1]))
			}
		}
	}
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "vendor" || n == "testdata" || n == ".git" || n == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		switch {
		case strings.HasSuffix(p, ".go") && !strings.HasSuffix(p, "_test.go"):
			f, perr := parser.ParseFile(fset, p, nil, 0)
			if perr != nil {
				return nil
			}
			ast.Inspect(f, func(n ast.Node) bool {
				if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
					if s, uerr := strconv.Unquote(lit.Value); uerr == nil {
						check(rel+":"+strconv.Itoa(fset.Position(lit.Pos()).Line), s)
					}
				}
				return true
			})
		case strings.HasPrefix(rel, "agent_docs"+string(filepath.Separator)) && strings.HasSuffix(p, ".md"):
			b, _ := os.ReadFile(p)
			for i, line := range strings.Split(string(b), "\n") {
				check(rel+":"+strconv.Itoa(i+1), line)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(bad)
	if len(bad) > 0 {
		t.Errorf("a Settings path names no section (real: %s):\n  %s", strings.Join(titles, ", "), strings.Join(bad, "\n  "))
	}
}
