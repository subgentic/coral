package agent

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Security's condition 1 on #14337 (#14353): a saved job or workflow step stored with no mode keeps today's meaning, print mode with no permission flag. The new default reaches a launch only through
// the launch routes, never through PrintArgs: its arguments for a stored step with no mode are exactly what they were before.
func TestAStoredStepWithNoModeHasTheSamePrintArgumentsAsBefore(t *testing.T) {
	setTestHome(t, t.TempDir())
	args, settingsFile, err := (&ClaudeAgent{}).PrintArgs(LaunchParams{WorkingDir: t.TempDir(), SessionID: "0b7f0f4e-3c1b-4c55-9b0e-0f6b1b2f1a11"})
	require.NoError(t, err)
	t.Cleanup(func() { os.Remove(settingsFile) })
	assert.Equal(t, []string{"--print", "--no-session-persistence", "--settings", settingsFile}, args, "no --permission-mode, nothing added")
	// and a mode the step stored is carried as it always was
	args, settingsFile2, err := (&ClaudeAgent{}).PrintArgs(LaunchParams{WorkingDir: t.TempDir(), SessionID: "0b7f0f4e-3c1b-4c55-9b0e-0f6b1b2f1a11", PermissionMode: "acceptEdits"})
	require.NoError(t, err)
	t.Cleanup(func() { os.Remove(settingsFile2) })
	assert.Equal(t, []string{"--print", "--no-session-persistence", "--settings", settingsFile2, "--permission-mode", "acceptEdits"}, args)
	// the Codex, agy and other steps: their flags are what the step stored
	a, _ := StepPrintArgs("codex", nil, nil, "do it")
	assert.NotContains(t, a, "--full-auto")
	assert.NotContains(t, a, "--dangerously-bypass-approvals-and-sandbox")
}
