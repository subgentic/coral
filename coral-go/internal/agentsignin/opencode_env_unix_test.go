//go:build !windows

package agentsignin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeOpencode answers `auth list` with one provider and writes the XDG_DATA_HOME it was run with to a file.
func fakeOpencode(t *testing.T) (bin, seen string) {
	t.Helper()
	dir := t.TempDir()
	seen = filepath.Join(dir, "seen")
	bin = filepath.Join(dir, "opencode")
	script := "#!/bin/sh\nprintf '%s' \"$XDG_DATA_HOME\" > '" + seen + "'\nprintf '\\342\\227\\217  OpenAI oauth\\n'\n"
	require.NoError(t, os.WriteFile(bin, []byte(script), 0o755))
	return bin, seen
}

func TestOpencodeIsAskedAboutTheAgentServersCredentialsNeverThePersons(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", "/home/person/.local/share")
	bin, seen := fakeOpencode(t)

	SetOpencodeEnv(nil)
	assert.Nil(t, OpencodeProviders(context.Background(), bin), "no folder of Coral's set: opencode is not run at all")
	assert.Equal(t, Unknown, CheckIn(context.Background(), "opencode", bin, ""))
	_, err := os.Stat(seen)
	assert.True(t, os.IsNotExist(err), "the person's own opencode was never asked")

	coral := t.TempDir()
	SetOpencodeEnv(func(base []string) []string {
		var env []string
		for _, kv := range base {
			if !strings.HasPrefix(kv, "XDG_") {
				env = append(env, kv)
			}
		}
		return append(env, "XDG_DATA_HOME="+filepath.Join(coral, "data"))
	})
	defer SetOpencodeEnv(nil)
	assert.Equal(t, map[string]bool{"openai": true}, OpencodeProviders(context.Background(), bin))
	got, err := os.ReadFile(seen)
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(coral, "data"), string(got), "it ran with the agent servers' folder, not the person's")
	assert.Equal(t, SignedIn, CheckIn(context.Background(), "opencode", bin, ""))
}
