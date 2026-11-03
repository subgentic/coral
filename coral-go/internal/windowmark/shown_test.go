package windowmark

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The record that the window was shown once (the tray writes it itself): a plain file or nothing, like the open mark, and never through a link.
func TestTheShownOnceRecordIsAPlainFileTheTrayWritesItself(t *testing.T) {
	dir := t.TempDir()
	assert.False(t, EverShown(dir))
	assert.False(t, EverShown(""), "no data folder, no record")
	NoteShown("")
	NoteShown(dir)
	assert.True(t, EverShown(dir))
	assert.False(t, Present(dir), "the open mark is a separate file")
	Clear(dir)
	assert.True(t, EverShown(dir), "closing the window does not undo that it was shown")

	other := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(other, ShownFileName), 0o755))
	assert.False(t, EverShown(other), "a folder of that name is no record")
	NoteShown(other) // refused, harmlessly
	assert.False(t, EverShown(other))
}
