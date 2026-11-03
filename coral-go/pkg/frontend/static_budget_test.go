package frontend

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The embedded static tree goes into every Coral server binary (and the Hub's), so what it holds
// costs every download. A 6.86 MB logo nothing referenced (static/corral.png) shipped in every
// binary until #3854. These checks keep that from coming back.

const (
	// staticBudget is the most the static tree a release ships may hold: its JS and CSS as the server serves them (minified, comments gone), every other file as it is, and the agent docs gzipped as
	// tools/sync-agent-docs.sh embeds them (#12865). Policy (the Operator's standing approval to raise it; this test only, never the start-CSS cap or the page_weight baselines): the budget is the tree
	// plus 64 KiB, rounded up to a whole KiB, and a raise is this one number in the commit that needs the room, with the reason in the commit message (git log -S staticBudget shows each raise).
	// The test logs the room left, warns under 32 KiB, and names the ten files that grew most since the checked-in baseline (static_budget_baseline.txt; regenerate it with STATIC_BUDGET_UPDATE=1).
	// 5,729,280 bytes: the tree after the agent docs went gzipped (5,663,162; it was 6,195,883 with them plain) plus 64 KiB.
	staticBudget = 5_729_280
	// fileBudget is the most one embedded file may hold (the CodeMirror bundle, the largest, is ~1 MB).
	fileBudget = 1536 << 10
	// budgetWarnRoom is the room under which the test warns, and budgetPolicyRoom the room a raise leaves.
	budgetWarnRoom   = 32 << 10
	budgetPolicyRoom = 64 << 10
)

// unreferencedImages are images nothing in this repository names, kept because something outside it
// may load them by URL (/static/<name>): Coral Hub serves this tree, and the icons are small.
var unreferencedImages = map[string]string{
	"coral_logo.png":       "logo, may be linked by URL from outside the repo (1 KB)",
	"coral_logo.svg":       "logo, may be linked by URL from outside the repo (9 KB)",
	"coral_tray.png":       "tray icon, may be linked by URL from outside the repo (1 KB)",
	"coral-icon-88x88.png": "icon, may be linked by URL from outside the repo (4 KB)",
}

// shippedStaticFiles is what a release's static tree holds, file by file: every embedded file as the server serves it (JS and CSS minified), and the agent docs counted once, from the embedded tree when this
// checkout has synced them into static/agent_docs (as <name>.md.gz, tools/sync-agent-docs.sh, #12865) and, when it has not (#10530), from docsDir (the source the sync reads) as the gzipped size the sync would
// write, so a checkout with the docs synced and one without measure the same release to within a few bytes. It returns each file's shipped bytes by path and the source bytes.
func shippedStaticFiles(fsys fs.FS, docsDir string) (files map[string]int64, source int64, err error) {
	files = map[string]int64{}
	synced := false
	err = fs.WalkDir(fsys, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if strings.HasPrefix(p, "static/agent_docs/") {
			synced = true
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		source += int64(len(data))
		// What a release carries: its JS and CSS are embedded already minified (tools/strip-static, #6208), the bytes the server serves; MinifyAsset is the identity for every other file.
		files[strings.TrimPrefix(p, "static/")] = int64(len(MinifyAsset(strings.TrimPrefix(p, "static/"), data)))
		return nil
	})
	if err != nil || synced {
		return files, source, err
	}
	entries, rerr := os.ReadDir(docsDir)
	if rerr != nil {
		return files, source, nil // no docs folder here: nothing to add
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, ierr := os.ReadFile(filepath.Join(docsDir, e.Name()))
		if ierr != nil {
			return files, source, ierr
		}
		source += int64(len(data))
		if strings.HasSuffix(e.Name(), ".md") {
			files["agent_docs/"+e.Name()+".gz"] = gzippedSize(data)
		} else {
			files["agent_docs/"+e.Name()] = int64(len(data))
		}
	}
	return files, source, nil
}

// gzippedSize is the size of data gzipped at the best level, what tools/sync-agent-docs.sh's gzip -9 -n writes (to within a few bytes).
func gzippedSize(data []byte) int64 {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(data)
	_ = zw.Close()
	return int64(buf.Len())
}

// shippedStaticBytes is the total of shippedStaticFiles, and the source bytes.
func shippedStaticBytes(fsys fs.FS, docsDir string) (total, source int64, err error) {
	files, source, err := shippedStaticFiles(fsys, docsDir)
	for _, n := range files {
		total += n
	}
	return total, source, err
}

const baselineFile = "static_budget_baseline.txt"

// readBaseline reads the checked-in baseline: one "bytes path" line per shipped file (nothing when there is none).
func readBaseline(path string) map[string]int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	out := map[string]int64{}
	for _, line := range strings.Split(string(b), "\n") {
		n, p, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		if v, err := strconv.ParseInt(n, 10, 64); err == nil {
			out[p] = v
		}
	}
	return out
}

// formatBaseline is the baseline file of files: largest first, one "bytes path" line each.
func formatBaseline(files map[string]int64) string {
	names := make([]string, 0, len(files))
	for p := range files {
		names = append(names, p)
	}
	sort.Slice(names, func(i, j int) bool {
		if files[names[i]] != files[names[j]] {
			return files[names[i]] > files[names[j]]
		}
		return names[i] < names[j]
	})
	var b strings.Builder
	for _, p := range names {
		fmt.Fprintf(&b, "%d %s\n", files[p], p)
	}
	return b.String()
}

// grewMost names the n files that grew most since the baseline (a file the baseline lacks counts as all its bytes), as "+bytes path (was bytes)".
func grewMost(cur, base map[string]int64, n int) []string {
	type g struct {
		p     string
		delta int64
	}
	var all []g
	for p, v := range cur {
		if d := v - base[p]; d > 0 {
			all = append(all, g{p, d})
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].delta != all[j].delta {
			return all[i].delta > all[j].delta
		}
		return all[i].p < all[j].p
	})
	var out []string
	for i := 0; i < len(all) && i < n; i++ {
		was := "new"
		if v, ok := base[all[i].p]; ok {
			was = fmt.Sprintf("was %d", v)
		}
		out = append(out, fmt.Sprintf("+%d %s (%s)", all[i].delta, all[i].p, was))
	}
	return out
}

// budgetReport says how the tree stands: the lines to log, and whether it is over the budget. It always says the room left; under budgetWarnRoom it warns; over, or under the warning, it names the ten files that
// grew most since the baseline (when there is one) and the budget a raise would set: the tree plus budgetPolicyRoom, to a whole KiB.
func budgetReport(cur, base map[string]int64, total, budget int64) (lines []string, over bool) {
	room := budget - total
	lines = append(lines, fmt.Sprintf("static tree a release ships: %d bytes (budget %d, room %d)", total, budget, room))
	if room >= budgetWarnRoom {
		return lines, false
	}
	over = room < 0
	suggest := (total + budgetPolicyRoom + 1023) / 1024 * 1024
	if over {
		lines = append(lines, fmt.Sprintf("OVER the budget by %d bytes: if the room is needed, set staticBudget = %d (the tree plus 64 KiB) in the commit that needs it, with the reason", -room, suggest))
	} else {
		lines = append(lines, fmt.Sprintf("WARNING: only %d bytes of room (under %d): the next feature will need staticBudget = %d (the tree plus 64 KiB) or a trim", room, budgetWarnRoom, suggest))
	}
	if base != nil {
		if g := grewMost(cur, base, 10); len(g) > 0 {
			lines = append(lines, "the files that grew most since "+baselineFile+":")
			for _, l := range g {
				lines = append(lines, "  "+l)
			}
		}
	}
	return lines, over
}

func TestStaticTreeWithinBudget(t *testing.T) {
	var big []string
	_ = fs.WalkDir(Static, "static", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, ierr := d.Info(); ierr == nil && info.Size() > fileBudget {
				big = append(big, fmt.Sprintf("%s is %d bytes, over the %d-byte budget for one embedded file: every Coral binary carries it", p, info.Size(), fileBudget))
			}
		}
		return nil
	})
	for _, m := range big {
		t.Error(m)
	}
	files, source, err := shippedStaticFiles(Static, filepath.Join("..", "..", "agent_docs"))
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, n := range files {
		total += n
	}
	if os.Getenv("STATIC_BUDGET_UPDATE") == "1" {
		if err := os.WriteFile(baselineFile, []byte(formatBaseline(files)), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("%s rewritten (%d files)", baselineFile, len(files))
	}
	lines, over := budgetReport(files, readBaseline(baselineFile), total, staticBudget)
	for _, l := range lines {
		t.Log(l)
	}
	if over {
		t.Errorf("the static tree a release ships is %d bytes, over its %d-byte budget (staticBudget): every Coral binary carries it\n%s", total, staticBudget, strings.Join(lines[1:], "\n"))
	}
	t.Logf("its source: %d bytes", source)
}

func isImage(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".avif", ".bmp":
		return true
	}
	return false
}

// TestStaticImagesAreReferenced fails on an embedded image whose file name appears nowhere in the
// static text files, the templates or the module's Go sources.
func TestStaticImagesAreReferenced(t *testing.T) {
	var images []string
	var corpus strings.Builder
	for _, root := range []struct {
		fsys fs.FS
		dir  string
	}{{Static, "static"}, {Templates, "templates"}} {
		err := fs.WalkDir(root.fsys, root.dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			if isImage(p) {
				if root.dir == "static" {
					images = append(images, p)
				}
				return nil
			}
			b, err := fs.ReadFile(root.fsys, p)
			if err != nil {
				return err
			}
			corpus.Write(b)
			corpus.WriteByte('\n')
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	// The module's Go sources (the server serves some icons by name, e.g. internal/server/static_assets.go).
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(moduleRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" || n == "bin" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "static_budget_test.go") {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		corpus.Write(b)
		corpus.WriteByte('\n')
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The Docs pages (coral-go/agent_docs) name their screenshots in static/docs-img (#5038). The copy `make` syncs into static/agent_docs is not in a clean checkout, so the
	// sources are read here.
	docs, err := filepath.Glob(filepath.Join(moduleRoot, "agent_docs", "*.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		b, err := os.ReadFile(d)
		if err != nil {
			t.Fatal(err)
		}
		corpus.Write(b)
		corpus.WriteByte('\n')
	}
	if len(images) == 0 {
		t.Fatal("found no images in the static tree; the walk is wrong")
	}
	text := corpus.String()
	for _, p := range images {
		name := path.Base(p)
		if strings.Contains(text, name) {
			if why, ok := unreferencedImages[name]; ok {
				t.Errorf("%s is referenced now; drop it from unreferencedImages (%s)", p, why)
			}
			continue
		}
		if _, ok := unreferencedImages[name]; ok {
			continue
		}
		t.Errorf("%s is embedded in every Coral binary but nothing names it (static text files, templates, Go sources): delete it, or reference it", p)
	}
	for name := range unreferencedImages {
		if _, err := fs.Stat(Static, "static/"+name); err != nil {
			t.Errorf("unreferencedImages lists %s, which is not in the static tree: drop it", name)
		}
	}
}

// nonWebAllowed are the files in the static tree that are not web assets, kept on purpose (#11492's audit found ~12 KB of notes and lists shipped in every binary for nothing).
var nonWebAllowed = map[string]string{
	"vendor/README.md":                  "read by tools/audit-frontend-deps.py (the weekly vulnerability audit) and kept equal to the vendored files by tests/frontend/vendor_manifest.mjs",
	"vendor/fonts/README.md":            "the fonts' licences and sources: the notice that goes with the font files",
	"vendor/xterm/addon-canvas.LICENSE": "the licence text of a vendored library",
	".gitkeep":                          "12 bytes: keeps static/ a directory the embed can name in a fresh checkout",
}

// webExt are the extensions of what a browser loads from the static tree.
var webExt = map[string]bool{".js": true, ".css": true, ".html": true, ".json": true, ".png": true, ".svg": true, ".ico": true, ".woff2": true}

// TestStaticTreeHoldsOnlyWebFiles fails on a file in the embedded static tree that a browser does not load: a README, a notes file (a CLAUDE.md), a name list. Notes and test data live outside static/ (the
// platform notes in pkg/frontend, the icon-name list in tests/frontend/fixtures); a licence or a file another tool reads is named above with its reason. The synced agent docs (static/agent_docs) are not web files
// either, and are counted by the budget above.
func TestStaticTreeHoldsOnlyWebFiles(t *testing.T) {
	_ = fs.WalkDir(Static, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(p, "static/")
		if strings.HasPrefix(rel, "agent_docs/") {
			return nil
		}
		if _, ok := nonWebAllowed[rel]; ok || webExt[strings.ToLower(path.Ext(rel))] {
			return nil
		}
		t.Errorf("%s is not a web file and every Coral binary carries it: move it outside static/ (notes next to the package, test data under tests/), or name it in nonWebAllowed with the reason it must ship", rel)
		return nil
	})
	for rel := range nonWebAllowed {
		if _, err := fs.Stat(Static, "static/"+rel); err != nil {
			t.Errorf("nonWebAllowed names %s, which is no longer in the static tree: remove the entry", rel)
		}
	}
}
