package routes

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A transcript line holds a Windows folder escaped (C:\work), as Claude writes it: the chat's starting mode is read from it on every OS, whatever the folder
// looks like there (#474: a test that spliced the raw folder into the line wrote invalid JSON on Windows, so its mode was never read).
func TestTheStartModeIsReadFromALineWithAnEscapedWindowsFolder(t *testing.T) {
	file := filepath.Join(t.TempDir(), "transcript.jsonl")
	line := `{"type":"user","cwd":` + jsonString(`C:\Users\a\work`) + `,"permissionMode":"plan","message":{"role":"user","content":"hi"}}` + "\n"
	require.NoError(t, os.WriteFile(file, []byte(line), 0o600))
	_, mode := transcriptStart(file)
	assert.Equal(t, "plan", mode)
}
