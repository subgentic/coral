package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11155: the apply's answer is kept in the updates folder, because the server that starts this program gives it nowhere to print.
func TestTheApplyKeepsItsAnswerInTheUpdatesFolder(t *testing.T) {
	data := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(data, "updates"), 0o700))
	var out bytes.Buffer
	printApply(&out, data, output{Result: "coral_running", Installed: "2.0.3"})
	printApply(&out, data, output{Result: "relaunched", Installed: "2.0.3", Version: "2.0.5"})
	assert.Contains(t, out.String(), "coral_running", "still printed")
	b, err := os.ReadFile(filepath.Join(data, "updates", "apply.log"))
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	require.Len(t, lines, 2)
	assert.Contains(t, lines[0], `"result":"coral_running"`)
	assert.Contains(t, lines[1], `"result":"relaunched"`)
	fi, err := os.Stat(filepath.Join(data, "updates", "apply.log"))
	require.NoError(t, err)
	assert.Zero(t, fi.Mode().Perm()&0o077, "not readable by others")

	// Large: it starts again.
	require.NoError(t, os.WriteFile(filepath.Join(data, "updates", "apply.log"), bytes.Repeat([]byte("x"), applyLogMax+1), 0o600))
	printApply(&out, data, output{Result: "refused"})
	b, _ = os.ReadFile(filepath.Join(data, "updates", "apply.log"))
	assert.Less(t, len(b), 1024)
	assert.Contains(t, string(b), "refused")

	// A link is never followed, and no updates folder means no file (the answer is still printed).
	other := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(other, "updates"), 0o700))
	target := filepath.Join(other, "elsewhere")
	require.NoError(t, os.WriteFile(target, []byte("keep"), 0o600))
	if os.Symlink(target, filepath.Join(other, "updates", "apply.log")) == nil {
		printApply(&out, other, output{Result: "refused"})
		kept, _ := os.ReadFile(target)
		assert.Equal(t, "keep", string(kept))
	}
	printApply(&out, t.TempDir(), output{Result: "refused"})
}
