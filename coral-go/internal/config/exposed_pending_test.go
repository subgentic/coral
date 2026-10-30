package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The marker is written as a new private file: a link at its name is removed, not followed, so the file it points to is left as it was.
func TestTheMarkerIsWrittenWithoutFollowingALink(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "target")
	require.NoError(t, os.WriteFile(target, []byte("keep"), 0o600))
	marker := filepath.Join(dir, ExposedPendingFile)
	if err := os.Symlink(target, marker); err != nil {
		t.Skipf("this system does not let this account make a symbolic link: %v", err)
	}

	require.NoError(t, writeExposedPending(dir))

	got, err := os.ReadFile(target)
	require.NoError(t, err)
	assert.Equal(t, "keep", string(got), "the link's target is untouched")
	fi, err := os.Lstat(marker)
	require.NoError(t, err)
	assert.True(t, fi.Mode().IsRegular(), "the marker is a plain file now, not the link")
	assert.True(t, DataDirMadePrivate(dir))
}

// An older marker is replaced, and DataDirMadePrivate sees only a plain file at that name.
func TestTheMarkerReplacesAnOlderOneAndOnlyAPlainFileCounts(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, ExposedPendingFile)
	require.NoError(t, os.WriteFile(marker, []byte("old"), 0o600))
	require.NoError(t, writeExposedPending(dir))
	got, err := os.ReadFile(marker)
	require.NoError(t, err)
	assert.NotEqual(t, "old", string(got))
	require.NoError(t, ClearDataDirExposed(dir))
	assert.False(t, DataDirMadePrivate(dir))

	require.NoError(t, os.Mkdir(marker, 0o700))
	assert.False(t, DataDirMadePrivate(dir), "a folder at that name is not the marker")
}
