package frontend

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
)

// A release embeds the agent docs that `make` syncs into static/agent_docs (tools/sync-agent-docs.sh), so what it ships is the static tree and those docs. The budget test measures the same bytes
// whether or not this checkout has synced them (#10530: it was 4.74 MB in CI, which does not sync, and 5.51 MB on every dev checkout, which does): the docs are counted from the embedded tree when
// they are there and from the source folder when they are not, never twice.
func TestShippedStaticBytesCountsTheAgentDocsOnceWhetherSyncedOrNot(t *testing.T) {
	docs := t.TempDir()
	if err := os.WriteFile(filepath.Join(docs, "a.md"), []byte(strings.Repeat("x", 1000)), 0o644); err != nil {
		t.Fatal(err)
	}
	unsynced := fstest.MapFS{"static/app.js": {Data: []byte(strings.Repeat("y", 500))}}
	zipped := gzipBytes(t, []byte(strings.Repeat("x", 1000)))
	synced := fstest.MapFS{"static/app.js": {Data: []byte(strings.Repeat("y", 500))}, "static/agent_docs/a.md.gz": {Data: zipped}}
	a, _, err := shippedStaticBytes(unsynced, docs)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := shippedStaticBytes(synced, docs)
	if err != nil {
		t.Fatal(err)
	}
	want := 500 + int64(len(zipped))
	if a != want || b != want {
		t.Errorf("a checkout without the docs synced and one with them must measure the same release: %d and %d (want %d both: the docs count gzipped, as the sync writes them, #12865)", a, b, want)
	}
}

func gzipBytes(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return buf.Bytes()
}

// #12865: with the docs synced (gzipped by tools/sync-agent-docs.sh) the tree measures what an unsynced checkout estimates from the sources, to within a KiB: the budget is the same either way.
func TestTheUnsyncedDocsEstimateMatchesTheSyncedGzip(t *testing.T) {
	synced, _, err := shippedStaticBytes(Static, filepath.Join("..", "..", "agent_docs"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Static.Open("static/agent_docs"); err != nil {
		t.Skip("docs not synced here: nothing to compare")
	}
	// A tree synced before agent_docs/ last changed (a checkout copied to another machine, a sync left by an earlier build) is a stale sync, not a wrong estimate: say so, as the server package's test does (#18354: epoch showed
	// "synced 6744831, estimate 6756678", 11.8 KB apart, which read as a bug in the estimate).
	if stale := staleEmbeddedDocs(t, Static, filepath.Join("..", "..", "agent_docs")); len(stale) > 0 {
		t.Fatalf("the embedded agent docs are stale: run tools/sync-agent-docs.sh and rebuild:\n  %s", strings.Join(stale, "\n  "))
	}
	// the same tree without its docs, plus the estimate from the sources
	files, _, _ := shippedStaticFiles(Static, filepath.Join("..", "..", "agent_docs"))
	var docs, rest int64
	for p, n := range files {
		if strings.HasPrefix(p, "agent_docs/") {
			docs += n
		} else {
			rest += n
		}
	}
	est := rest
	entries, _ := os.ReadDir(filepath.Join("..", "..", "agent_docs"))
	for _, e := range entries {
		if b, err := os.ReadFile(filepath.Join("..", "..", "agent_docs", e.Name())); err == nil && strings.HasSuffix(e.Name(), ".md") {
			est += gzippedSize(b)
		}
	}
	// to within a KiB, or 2% of the docs' size: Go's own gzip at its best level is a different compressor from the gzip -9 that tools/sync-agent-docs.sh runs, and a newer Go compresses these docs
	// about 0.8% smaller than gzip -9 does (Go 1.27.3: 2,611 bytes under 315,105), which is no change in what ships.
	tol := max(int64(1024), docs/50)
	if d := synced - est; d > tol || d < -tol {
		t.Errorf("the synced tree is %d bytes and the unsynced estimate %d: more than %d bytes apart (docs %d)", synced, est, tol, docs)
	}
}

func TestTheBudgetReportLogsRoomWarnsAndNamesTheFilesThatGrew(t *testing.T) {
	base := map[string]int64{"a.js": 100, "b.js": 200, "c.css": 300}
	cur := map[string]int64{"a.js": 100, "b.js": 900, "c.css": 350, "new.js": 40}
	total := int64(1390)
	// plenty of room: one line
	lines, over := budgetReport(cur, base, total, total+budgetWarnRoom+1)
	if over || len(lines) != 1 || !strings.Contains(lines[0], "room 32769") {
		t.Errorf("room left is said and nothing more: %v", lines)
	}
	// under the warning: warns, says the next budget, names the growers
	lines, over = budgetReport(cur, base, total, total+100)
	text := strings.Join(lines, "\n")
	if over || !strings.Contains(text, "WARNING") || !strings.Contains(text, "staticBudget = 67584") || !strings.Contains(text, "+700 b.js (was 200)") || !strings.Contains(text, "+40 new.js (new)") {
		t.Errorf("a warning under %d bytes of room names the next budget and the growers: %v", budgetWarnRoom, lines)
	}
	if strings.Index(text, "+700 b.js") > strings.Index(text, "+50 c.css") {
		t.Errorf("the largest growth comes first: %v", lines)
	}
	// over: fails and says by how much
	lines, over = budgetReport(cur, base, total, total-1)
	if !over || !strings.Contains(strings.Join(lines, "\n"), "OVER the budget by 1 bytes") {
		t.Errorf("over the budget: %v", lines)
	}
	// no baseline: no growers, still a verdict
	lines, _ = budgetReport(cur, nil, total, total+10)
	if strings.Contains(strings.Join(lines, "\n"), "grew most") {
		t.Errorf("no baseline, no growers: %v", lines)
	}
	// ten at most
	big := map[string]int64{}
	for i := 0; i < 30; i++ {
		big[fmt.Sprintf("f%02d.js", i)] = int64(i + 1)
	}
	if g := grewMost(big, nil, 10); len(g) != 10 || !strings.HasPrefix(g[0], "+30 ") {
		t.Errorf("the ten largest growers: %v", g)
	}
}

func TestTheBaselineFileRoundTrips(t *testing.T) {
	files := map[string]int64{"vendor/x.js": 900, "a.css": 5, "b.css": 5}
	text := formatBaseline(files)
	path := filepath.Join(t.TempDir(), baselineFile)
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	got := readBaseline(path)
	names := make([]string, 0, len(got))
	for p := range got {
		names = append(names, p)
	}
	sort.Strings(names)
	if len(got) != 3 || got["vendor/x.js"] != 900 || got["a.css"] != 5 || !strings.HasPrefix(text, "900 vendor/x.js\n5 a.css\n5 b.css\n") {
		t.Errorf("largest first, ties by name, read back whole: %q %v", text, names)
	}
	if readBaseline(filepath.Join(t.TempDir(), "none.txt")) != nil {
		t.Error("no baseline file: nil")
	}
}

// staleEmbeddedDocs names each agent_docs/*.md whose embedded .gz copy is missing or unzips to other bytes, and each embedded copy of a doc that is gone from agent_docs/.
func staleEmbeddedDocs(t *testing.T, embedded fs.FS, src string) []string {
	t.Helper()
	var stale []string
	have := map[string]bool{}
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Skip("no agent_docs folder beside this module")
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		have[e.Name()+".gz"] = true
		want, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			continue
		}
		zipped, err := fs.ReadFile(embedded, "static/agent_docs/"+e.Name()+".gz")
		if err != nil {
			stale = append(stale, e.Name()+" (missing from the embedded copy)")
			continue
		}
		zr, err := gzip.NewReader(bytes.NewReader(zipped))
		if err != nil {
			stale = append(stale, e.Name()+" (embedded copy is not gzip)")
			continue
		}
		got, _ := io.ReadAll(zr)
		if !bytes.Equal(got, want) {
			stale = append(stale, e.Name()+" (differs from agent_docs/)")
		}
	}
	if entries, err := fs.ReadDir(embedded, "static/agent_docs"); err == nil {
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".md.gz") && !have[e.Name()] {
				stale = append(stale, strings.TrimSuffix(e.Name(), ".gz")+" (no longer in agent_docs/)")
			}
		}
	}
	return stale
}

// #18354: a doc edited after the sync, one added since and one removed since are each named as stale; a fresh sync names nothing.
func TestAnEditedAddedOrRemovedDocIsNamedAsStaleInTheEmbeddedCopy(t *testing.T) {
	src := t.TempDir()
	for name, body := range map[string]string{"a.md": "alpha", "b.md": "bravo", "c.md": "charlie"} {
		if err := os.WriteFile(filepath.Join(src, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	zip := func(s string) *fstest.MapFile { return &fstest.MapFile{Data: gzipBytes(t, []byte(s))} }
	fresh := fstest.MapFS{"static/agent_docs/a.md.gz": zip("alpha"), "static/agent_docs/b.md.gz": zip("bravo"), "static/agent_docs/c.md.gz": zip("charlie")}
	if got := staleEmbeddedDocs(t, fresh, src); len(got) != 0 {
		t.Errorf("a fresh sync names nothing: %v", got)
	}
	old := fstest.MapFS{"static/agent_docs/a.md.gz": zip("alpha OLD"), "static/agent_docs/b.md.gz": zip("bravo"), "static/agent_docs/gone.md.gz": zip("x")}
	got := strings.Join(staleEmbeddedDocs(t, old, src), "|")
	for _, want := range []string{"a.md (differs from agent_docs/)", "c.md (missing from the embedded copy)", "gone.md (no longer in agent_docs/)"} {
		if !strings.Contains(got, want) {
			t.Errorf("want %q in the stale list: %s", want, got)
		}
	}
	if strings.Contains(got, "b.md") {
		t.Errorf("b.md is current: %s", got)
	}
}
