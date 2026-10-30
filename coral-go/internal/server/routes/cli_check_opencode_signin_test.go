package routes

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agentsignin"
)

// opencode signs in in the folder the agents' servers use, so a "not signed in" answer carries the one command that signs in there (#11364).
func TestCLICheckGivesOpencodesSignInCommandOnlyWhenItIsNotSignedIn(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary")
	}
	agentsignin.SetOpencodeEnv(func(base []string) []string { return base })
	defer agentsignin.SetOpencodeEnv(nil)
	for name, tc := range map[string]struct {
		list   string
		signed string
	}{
		"signed out": {"└  0 credentials", `"signed_in":false`},
		"signed in":  {"●  OpenAI oauth", `"signed_in":true`},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			script := "#!/bin/sh\nif [ \"$1\" = auth ]; then echo '" + tc.list + "'; exit 0; fi\necho 2.2.4\n"
			require.NoError(t, os.WriteFile(filepath.Join(dir, "opencode"), []byte(script), 0o755))
			t.Setenv("PATH", dir+string(os.PathListSeparator)+"/usr/bin"+string(os.PathListSeparator)+"/bin")
			signInAskMu.Lock()
			delete(signInAskedAt, "opencode")
			signInAskMu.Unlock()
			body := cliCheckBody(t, "type=opencode&signin=1")
			assert.Contains(t, body, tc.signed)
			if name == "signed out" {
				assert.Contains(t, body, "auth login")
				assert.Contains(t, body, "XDG_DATA_HOME")
			} else {
				assert.NotContains(t, body, "signin_command")
			}
		})
	}
}
