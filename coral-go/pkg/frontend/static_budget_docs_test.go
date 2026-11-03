package frontend

import (
	"bytes"
	"compress/gzip"
	"fmt"
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
	if d := synced - est; d > 1024 || d < -1024 {
		t.Errorf("the synced tree is %d bytes and the unsynced estimate %d: more than 1 KiB apart (docs %d)", synced, est, docs)
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
