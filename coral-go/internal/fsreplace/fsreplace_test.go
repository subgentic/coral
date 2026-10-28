package fsreplace

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRenameReplacesAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	from, to := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	require.NoError(t, os.WriteFile(from, []byte("new"), 0o600))
	require.NoError(t, os.WriteFile(to, []byte("old"), 0o600))
	require.NoError(t, Rename(from, to))
	got, err := os.ReadFile(to)
	require.NoError(t, err)
	assert.Equal(t, "new", string(got))
	_, err = os.Stat(from)
	assert.True(t, os.IsNotExist(err), "the source is gone")
}

func TestRenameReturnsAMissingSourceAtOnce(t *testing.T) {
	dir := t.TempDir()
	start := time.Now()
	err := Rename(filepath.Join(dir, "nope"), filepath.Join(dir, "b"))
	assert.True(t, os.IsNotExist(err), "%v", err)
	assert.Less(t, time.Since(start), time.Second, "an error that is not a busy file is not retried")
}

// #9738: on Windows a reader holding the destination open (Go opens without FILE_SHARE_DELETE) fails a plain os.Rename at once; the replace outlasts a reader that lets go within a moment. On Unix the
// rename never notices the reader, so the test passes there with or without the wait.
func TestRenameWhileAReaderHasTheDestinationOpen(t *testing.T) {
	dir := t.TempDir()
	from, to := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	require.NoError(t, os.WriteFile(from, []byte("new"), 0o600))
	require.NoError(t, os.WriteFile(to, []byte("old"), 0o600))
	f, err := os.Open(to)
	require.NoError(t, err)
	t.Cleanup(func() { f.Close() })
	release := time.AfterFunc(300*time.Millisecond, func() { f.Close() })
	t.Cleanup(func() { release.Stop() })
	require.NoError(t, Rename(from, to))
	got, err := os.ReadFile(to)
	require.NoError(t, err)
	assert.Equal(t, "new", string(got))
}
