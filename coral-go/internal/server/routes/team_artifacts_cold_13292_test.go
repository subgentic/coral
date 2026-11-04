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

// #13361 (the #13292 review's surviving mutants): each rule that decides a record file is NOT read again is pinned alone. A file counts as unchanged only when its size, its time and its age (not written in the last uploadDirSettle) all say so.
func touchDir(t *testing.T, coral, sid string, at time.Time) {
	t.Helper()
	require.NoError(t, os.Chtimes(uploadsDir(coral, sid), at, at)) // the folder's time moved: it is listed again
}

func rewriteRecord(t *testing.T, coral, sid string, i int, name string, size int64, mtime time.Time) {
	t.Helper()
	id := fmt.Sprintf("%064x", i+1)
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: name, MediaType: "text/markdown", Size: size, Digest: "sha256:" + id}, CreatedAt: "2026-10-01T10:00:00Z"})
	p := filepath.Join(uploadsDir(coral, sid), id+".json")
	require.NoError(t, os.WriteFile(p, rec, 0o644))
	require.NoError(t, os.Chtimes(p, mtime, mtime))
}

func TestAChangedFolderRereadsAFileWrittenInTheLastMomentsAndOnlyThat(t *testing.T) {
	coral := t.TempDir()
	writeSettledUploads(t, coral, "sess-s", 0, 5)
	// one record written just now (its file time is recent) inside a folder whose own time is old
	rewriteRecord(t, coral, "sess-s", 2, "fresh.md", 3, time.Now())
	old := time.Now().Add(-time.Hour)
	touchDir(t, coral, "sess-s", old)
	reads := countUploadReads(t)
	var c uploadDirCache
	require.Len(t, c.list(coral, "sess-s"), 5)
	require.EqualValues(t, 5, reads.Load(), "cold: all five")
	touchDir(t, coral, "sess-s", old.Add(time.Minute)) // the folder changed: listed again
	require.Len(t, c.list(coral, "sess-s"), 5)
	require.EqualValues(t, 6, reads.Load(), "the four settled files are reused and the one written in the last moments is read again (a mutant without the age rule reuses it: 5)")
}

func TestAFileWhoseSizeChangedIsReadAgainEvenWithTheSameTime(t *testing.T) {
	coral := t.TempDir()
	writeSettledUploads(t, coral, "sess-z", 0, 3)
	old := time.Now().Add(-time.Hour)
	reads := countUploadReads(t)
	var c uploadDirCache
	require.Len(t, c.list(coral, "sess-z"), 3)
	require.EqualValues(t, 3, reads.Load())
	st, err := os.Stat(filepath.Join(uploadsDir(coral, "sess-z"), fmt.Sprintf("%064x", 2)+".json"))
	require.NoError(t, err)
	rewriteRecord(t, coral, "sess-z", 1, "a-much-longer-name-than-before.md", 3, st.ModTime()) // a different size, the file's time put back to exactly what it was
	touchDir(t, coral, "sess-z", old.Add(time.Minute))
	got := c.list(coral, "sess-z")
	require.EqualValues(t, 4, reads.Load(), "the size alone says it changed (a mutant that compares only the time reuses it: 3)")
	var names []string
	for _, u := range got {
		names = append(names, u.rec.Name)
	}
	require.Contains(t, names, "a-much-longer-name-than-before.md")
}

func TestAFileWhoseTimeChangedIsReadAgainEvenWithTheSameSize(t *testing.T) {
	coral := t.TempDir()
	writeSettledUploads(t, coral, "sess-t", 0, 3)
	old := time.Now().Add(-time.Hour)
	reads := countUploadReads(t)
	var c uploadDirCache
	require.Len(t, c.list(coral, "sess-t"), 3)
	require.EqualValues(t, 3, reads.Load())
	// the same number of bytes (f1.md -> g1.md), a new settled time
	rewriteRecord(t, coral, "sess-t", 1, "g1.md", 3, old.Add(10*time.Minute))
	touchDir(t, coral, "sess-t", old.Add(time.Minute))
	got := c.list(coral, "sess-t")
	require.EqualValues(t, 4, reads.Load(), "the time alone says it changed (a mutant that compares only the size reuses it: 3)")
	var names []string
	for _, u := range got {
		names = append(names, u.rec.Name)
	}
	require.Contains(t, names, "g1.md")
}
