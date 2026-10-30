package routes

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// #11293 (row 18): Pi was not an eligible CLI for theme generation. Asked for Pi, the generator is Pi run one-shot with no tools and no session kept (nothing it does can touch the folder it is started
// in), and it is the last resort when no other CLI is found; the other CLIs' choice is unchanged.
func TestThemeGenerationCanUsePi(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary")
	}
	dir := t.TempDir()
	pi := filepath.Join(dir, "pi")
	require.NoError(t, os.WriteFile(pi, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	settings := map[string]string{agent.CLIPathSettingKey(at.Pi): pi}
	t.Setenv("HOME", t.TempDir())     // no CLI of this machine is found in its usual folders
	t.Setenv("PATH", "/usr/bin:/bin") // nor on PATH

	path, args, which := resolveThemeCLIAgent(settings, "pi")
	assert.Equal(t, pi, path)
	assert.Equal(t, at.Pi, which)
	assert.Equal(t, []string{"--print", "--no-session", "--no-approve", "--no-tools"}, args)

	path, _, which = resolveThemeCLIAgent(settings, "")
	assert.Equal(t, pi, path, "with no other CLI found, Pi is the last resort")
	assert.Equal(t, at.Pi, which)
}
