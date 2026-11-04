//go:build !windows

package windowmark

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The record is created 0600, only this user's (coral-hub QA's SHOULD on #290): a 0644 create fails here. The umask can only take bits away, so 0600 stays 0600.
func TestTheShownOnceRecordIsCreatedOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	NoteShown(dir)
	fi, err := os.Stat(filepath.Join(dir, ShownFileName))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
}
