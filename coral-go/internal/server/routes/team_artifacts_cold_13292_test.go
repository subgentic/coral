package routes

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// #13292: the first artifacts read of a board took 3.85 s at 20,000 uploads (every record file read one after the other). A directory is now read by several at once, a directory that changed re-reads only the files that did,
// and the server reads every directory in the background after a start, so the first read finds them cached.
func writeSettledUploads(t *testing.T, coralDir, sid string, from, to int) {
	t.Helper()
	dir := uploadsDir(coralDir, sid)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	old := time.Now().Add(-time.Hour)
	for i := from; i < to; i++ {
		id := fmt.Sprintf("%064x", i+1)
		rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: fmt.Sprintf("f%d.md", i), MediaType: "text/markdown", Size: 3, Digest: "sha256:" + id}, CreatedAt: "2026-10-01T10:00:00Z"})
		p := filepath.Join(dir, id+".json")
		require.NoError(t, os.WriteFile(p, rec, 0o644))
		require.NoError(t, os.Chtimes(p, old, old))
	}
	require.NoError(t, os.Chtimes(dir, old, old))
}

func countUploadReads(t *testing.T) *atomic.Int64 {
	t.Helper()
	var n atomic.Int64
	uploadRecordReadHook = func() { n.Add(1) }
	t.Cleanup(func() { uploadRecordReadHook = func() {} })
	return &n
}

func TestAColdUploadDirIsReadOnceAndAChangedOneReadsOnlyWhatChanged(t *testing.T) {
	coral := t.TempDir()
	writeSettledUploads(t, coral, "sess-a", 0, 300)
	reads := countUploadReads(t)
	var c uploadDirCache
	require.Len(t, c.list(coral, "sess-a"), 300)
	require.EqualValues(t, 300, reads.Load(), "a cold directory reads each record once")
	require.Len(t, c.list(coral, "sess-a"), 300)
	require.EqualValues(t, 300, reads.Load(), "a settled, unchanged directory reads none")

	writeSettledUploads(t, coral, "sess-a", 300, 301) // one new record: the directory's time moves
	got := c.list(coral, "sess-a")
	require.Len(t, got, 301)
	require.EqualValues(t, 301, reads.Load(), "one new file is one more read, not 301 again (was a full re-read)")
	names := map[string]bool{}
	for _, u := range got {
		names[u.rec.Name] = true
	}
	require.True(t, names["f0.md"] && names["f300.md"], "old and new records are both there")
}

func TestAWrittenRecordIsReadAgain(t *testing.T) {
	coral := t.TempDir()
	writeSettledUploads(t, coral, "sess-b", 0, 3)
	var c uploadDirCache
	require.Len(t, c.list(coral, "sess-b"), 3)
	id := fmt.Sprintf("%064x", 2)
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "renamed-with-a-longer-name.md", MediaType: "text/markdown", Size: 3, Digest: "sha256:" + id}, CreatedAt: "2026-10-02T10:00:00Z"})
	p := filepath.Join(uploadsDir(coral, "sess-b"), id+".json")
	require.NoError(t, os.WriteFile(p, rec, 0o644))
	old := time.Now().Add(-30 * time.Minute)
	require.NoError(t, os.Chtimes(p, old, old))
	require.NoError(t, os.Chtimes(uploadsDir(coral, "sess-b"), old, old))
	var names []string
	for _, u := range c.list(coral, "sess-b") {
		names = append(names, u.rec.Name)
	}
	require.Contains(t, names, "renamed-with-a-longer-name.md", "a record that was written since is read again")
	require.NotContains(t, names, "f1.md")
}

func TestWarmReadsEveryUploadDirectoryBeforeTheFirstRead(t *testing.T) {
	coral := t.TempDir()
	for i, sid := range []string{"s1", "s2", "s3", "s4", "s5"} {
		writeSettledUploads(t, coral, sid, i*100, i*100+40)
	}
	reads := countUploadReads(t)
	var c uploadDirCache
	c.warm(coral)
	require.EqualValues(t, 200, reads.Load(), "the warm read all 5 directories")
	for _, sid := range []string{"s1", "s2", "s3", "s4", "s5"} {
		require.Len(t, c.list(coral, sid), 40)
	}
	require.EqualValues(t, 200, reads.Load(), "the first reads after it read no file")
}
