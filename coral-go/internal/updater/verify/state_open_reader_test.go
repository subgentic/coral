package verify

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9738 (Windows check of the updater stack, #9726): the check's record is written into state.json by every check, and read by every status the server asks for (a process of its own), so a reader
// can have the file open at the moment a write renames over it. On Windows Go opens a file without FILE_SHARE_DELETE, so a plain os.Rename over a file that a reader (or a virus scanner) holds fails
// with a sharing violation or access denied until the reader lets go; on Unix the rename just replaces it. The write must outlast a reader that holds the file for a moment: the record of a check is not
// to be lost because the dashboard happened to ask for the status while it was written.
func TestSaveStateWhileAReaderHasTheFileOpen(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, SaveState(dir, State{}))
	f, err := os.Open(filepath.Join(dir, StateFile)) // the way readPrivate opens it
	require.NoError(t, err)
	t.Cleanup(func() { f.Close() })
	release := time.AfterFunc(300*time.Millisecond, func() { f.Close() }) // a reader is quick: a read of a few hundred bytes, a scan
	t.Cleanup(func() { release.Stop() })

	want := &CheckResult{Result: "up_to_date", Newest: "1.4.131", At: "2026-10-28T12:00:00Z"}
	require.NoError(t, SaveState(dir, State{LastResult: want}), "the write waits out a reader that has the file open")
	got, err := LoadState(dir)
	require.NoError(t, err)
	assert.Equal(t, want, got.LastResult, "and the record is the one written")
}
