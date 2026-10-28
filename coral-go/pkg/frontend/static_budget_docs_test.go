package frontend

import (
	"os"
	"path/filepath"
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
	synced := fstest.MapFS{"static/app.js": {Data: []byte(strings.Repeat("y", 500))}, "static/agent_docs/a.md": {Data: []byte(strings.Repeat("x", 1000))}}
	a, _, err := shippedStaticBytes(unsynced, docs)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := shippedStaticBytes(synced, docs)
	if err != nil {
		t.Fatal(err)
	}
	if a != 1500 || b != 1500 {
		t.Errorf("a checkout without the docs synced and one with them must measure the same release: %d and %d (want 1500 both)", a, b)
	}
}
