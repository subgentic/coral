package frontend

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// #596: New agent's setup check read the agent type from #launch-type, an element that had been gone since the launch form became the agent
// config form, so the lookup found nothing and the check always asked about Claude. Every element id the Where step (launch_where.js) looks up
// must be one the page has: written in a template, or given by a static script.
var (
	byIDCall   = regexp.MustCompile(`getElementById\(([^()]*)\)`)
	quotedID   = regexp.MustCompile(`'([A-Za-z][\w-]*)'|"([A-Za-z][\w-]*)"`)
	hashInText = regexp.MustCompile(`['"\x60]#([A-Za-z][\w-]*)`)
	idInMarkup = regexp.MustCompile(`\bid\s*=\s*\\?["']([A-Za-z][\w-]*)\\?["']`)
	idInScript = regexp.MustCompile(`\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]|\bid:\s*['"]([A-Za-z][\w-]*)['"]`)
)

// idsLookedUp: the literal ids a script asks for, by getElementById (each quoted id in its argument, so both ids of a ternary) and by a
// selector that starts with #. An id made from a template literal is left out: its value is only known when it runs.
func idsLookedUp(src string) []string {
	seen := map[string]bool{}
	for _, m := range byIDCall.FindAllStringSubmatch(src, -1) {
		if strings.Contains(m[1], "${") {
			continue
		}
		for _, ix := range quotedID.FindAllStringSubmatchIndex(m[1], -1) {
			if before := strings.TrimSpace(m[1][:ix[0]]); strings.HasSuffix(before, "=") { // kind === 'team' compares; it is not an id
				continue
			}
			q := quotedID.FindStringSubmatch(m[1][ix[0]:ix[1]])
			seen[q[1]+q[2]] = true
		}
	}
	for _, m := range hashInText.FindAllStringSubmatch(src, -1) {
		seen[m[1]] = true
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// pageIDs: every id the templates write and the static scripts give an element.
func pageIDs(t *testing.T) map[string]bool {
	t.Helper()
	ids := map[string]bool{}
	add := func(re *regexp.Regexp, b []byte) {
		for _, m := range re.FindAllSubmatch(b, -1) {
			for _, g := range m[1:] {
				if len(g) > 0 {
					ids[string(g)] = true
				}
			}
		}
	}
	for _, dir := range []string{"templates", "static"} {
		err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			if ext := filepath.Ext(p); ext != ".html" && ext != ".js" {
				return nil
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			add(idInMarkup, b)
			if filepath.Ext(p) == ".js" {
				add(idInScript, b)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("reading %s: %v", dir, err)
		}
	}
	return ids
}

func TestLaunchWhereLooksUpOnlyIDsThePageHas(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("static", "launch_where.js"))
	if err != nil {
		t.Fatal(err)
	}
	ids := pageIDs(t)
	looked := idsLookedUp(string(src))
	if len(looked) < 3 {
		t.Fatalf("found only %d ids looked up in launch_where.js (%v): the patterns no longer match the script", len(looked), looked)
	}
	for _, id := range looked {
		if !ids[id] {
			t.Errorf("launch_where.js looks up #%s, but no template writes that id and no static script gives it: the lookup finds nothing (#596: #launch-type made New agent check Claude whatever was picked)", id)
		}
	}
}

// The lookups are read as the bug was written: a ternary's two ids, a selector's #id, and not an id built at run time.
func TestIDsLookedUpReadsTernariesAndSelectors(t *testing.T) {
	src := "document.getElementById(kind === 'team' ? 'team-agent-type' : 'launch-type'); document.querySelector('#launch-agent-acf .acf-agent-type'); document.getElementById(`launch-where-why-${p.kind}`)"
	got := strings.Join(idsLookedUp(src), " ")
	if got != "launch-agent-acf launch-type team-agent-type" {
		t.Fatalf("idsLookedUp = %q, want the ternary's two ids and the selector's", got)
	}
}
