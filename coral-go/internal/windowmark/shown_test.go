package windowmark

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/linktest"
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

// NoteShown never writes through a link planted at the record's name (coral-hub QA's SHOULD on #290): a symbolic link, a junction (a folder) or a hard link is refused
// and its target is untouched, so swapping the no-follow open for a plain open fails here. (The symbolic link case skips where this user cannot make one; CI runs it.)
func TestNoteShownNeverWritesThroughALink(t *testing.T) {
	dir := t.TempDir()
	linktest.Each(t, filepath.Join(dir, ShownFileName), func(t *testing.T, p linktest.Planted) {
		NoteShown(dir)
		if p.Kind != "hardlink" { // a hard link is a plain file by that name; what matters, and what the harness checks, is that its target is not written through
			assert.False(t, EverShown(dir), "a link is no record, and NoteShown did not turn it into one")
		}
	})
}
