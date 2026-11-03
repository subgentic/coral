package server

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The startup line (#4533): the count and a hash of the embedded agent docs, or a warning naming the sync script when there
// are none; the hash changes when any doc does.
func TestAgentDocsStartupLine(t *testing.T) {
	docs := fstest.MapFS{"a.md": {Data: []byte("# A\n")}, "b.md": {Data: []byte("# B\n")}}
	line := agentDocsStartupLine(docs)
	assert.Regexp(t, `^\[STARTUP\] agent docs 2 files, sha [0-9a-f]{8}$`, line)
	assert.Equal(t, line, agentDocsStartupLine(docs), "the same docs, the same line")
	docs["b.md"] = &fstest.MapFile{Data: []byte("# B, changed\n")}
	assert.NotEqual(t, line, agentDocsStartupLine(docs), "a changed doc changes the hash")

	empty := agentDocsStartupLine(fstest.MapFS{})
	assert.Contains(t, empty, "WARNING")
	assert.Contains(t, empty, "embeds no agent docs")
	assert.Contains(t, empty, "tools/sync-agent-docs.sh")
}

// The embedded agent docs are the ones in agent_docs/ (#4533): static/agent_docs is a gitignored copy that
// tools/sync-agent-docs.sh refreshes before a build, and a plain go build embeds whatever copy the tree holds. When this build
// embeds docs, each must equal its agent_docs/ source and none may be missing or extra. CI and make sync first, so this bites
// only a stale local copy; with no docs embedded (a fresh tree, never synced) the startup warning says so and this is skipped.
func TestEmbeddedAgentDocsMatchTheSources(t *testing.T) {
	sub, err := fs.Sub(staticFS, "static/agent_docs")
	require.NoError(t, err)
	embedded := newGzDocsFS(sub) // the docs are embedded gzipped (#6814): compared as the plain text they unzip to
	n, _ := agentDocsDigest(embedded)
	if n == 0 {
		t.Skip("this build embeds no agent docs (run tools/sync-agent-docs.sh to embed and check them)")
	}
	const src = "../../agent_docs"
	want := map[string][]byte{}
	require.NoError(t, filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		rel, _ := filepath.Rel(src, p)
		want[filepath.ToSlash(rel)] = b
		return err
	}))
	require.NotEmpty(t, want)
	var stale []string
	require.NoError(t, fs.WalkDir(embedded, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		got, err := fs.ReadFile(embedded, name)
		if err != nil {
			return err
		}
		w, ok := want[name]
		switch {
		case !ok:
			stale = append(stale, name+" (no longer in agent_docs/)")
		case string(w) != string(got):
			stale = append(stale, name+" (differs from agent_docs/)")
		}
		delete(want, name)
		return nil
	}))
	for name := range want {
		stale = append(stale, name+" (missing from the embedded copy)")
	}
	assert.Empty(t, stale, "the embedded agent docs are stale: run tools/sync-agent-docs.sh and rebuild:\n  %s", strings.Join(stale, "\n  "))
}

// #12865: a synced tree holds every doc ONLY as <name>.md.gz (848 KB of Markdown ship as 315 KB), never also as plain text, and each unzips to exactly its agent_docs/ source (the server reads
// the .gz copies as the plain files, #6814). Skipped with no docs embedded, like the test above.
func TestSyncedAgentDocsAreEmbeddedGzippedAndServedWithTheSourceBytes(t *testing.T) {
	sub, err := fs.Sub(staticFS, "static/agent_docs")
	require.NoError(t, err)
	entries, err := fs.ReadDir(sub, ".")
	if err != nil || len(entries) == 0 {
		t.Skip("this build embeds no agent docs (run tools/sync-agent-docs.sh)")
	}
	const src = "../../agent_docs"
	sources, err := os.ReadDir(src)
	require.NoError(t, err)
	for _, e := range sources {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		_, plain := fs.Stat(sub, e.Name())
		assert.Error(t, plain, "%s is embedded as plain text: the sync must write %s.gz only", e.Name(), e.Name())
		zipped, err := fs.ReadFile(sub, e.Name()+".gz")
		require.NoError(t, err, "%s.gz is not embedded", e.Name())
		want, err := os.ReadFile(filepath.Join(src, e.Name()))
		require.NoError(t, err)
		assert.Less(t, len(zipped), len(want), "%s.gz is not smaller than the source", e.Name())
		got, err := fs.ReadFile(newGzDocsFS(sub), e.Name()) // what the server serves for the doc
		require.NoError(t, err)
		assert.Equal(t, string(want), string(got), "%s is served with other bytes than its source", e.Name())
	}
}
