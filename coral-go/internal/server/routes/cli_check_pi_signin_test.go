package routes

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11293 (row 13): Pi's sign-in is asked for the provider Pi starts on, so the answer names it (Settings shows "Signed in to openai"): signed_in and provider together. A Claude answer has no provider.
func TestCLICheckNamesTheProviderOfAPiSignInAnswer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = auth ]; then echo '{\"status\":\"ready\",\"provider\":\"openai\"}'; exit 0; fi\necho 1.4.0\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "pi"), []byte(script), 0o755))
	t.Setenv("HOME", t.TempDir())
	piHome := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(piHome, "settings.json"), []byte(`{"defaultProvider":"openai"}`), 0o600))
	t.Setenv("PI_CODING_AGENT_DIR", piHome)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+"/usr/bin"+string(os.PathListSeparator)+"/bin")
	signInAskMu.Lock()
	delete(signInAskedAt, "pi")
	signInAskMu.Unlock()

	body := cliCheckBody(t, "type=pi&signin=1")
	assert.Contains(t, body, `"signed_in":true`)
	assert.Contains(t, body, `"provider":"openai"`)

	assert.NotContains(t, cliCheckBody(t, "type=pi"), "provider", "not asked for: nothing about a provider")
}
