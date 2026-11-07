package heavy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14354: the ssh alias of a heavy-run destination comes from the machine the pool grant names, not from a name in the code. The pool is the Operator's or an Orchestrator's to define, so an agent or an
// environment variable cannot send a worktree anywhere else; the Host block of that name is in the Operator's ssh config.
func TestAliasForIsTheGrantsMachineAndNothingElse(t *testing.T) {
	for machine, want := range map[string]string{
		"mini":         "coral-heavy-mini",
		"Build Box 2":  "coral-heavy-build-box-2",
		"  box  ":      "coral-heavy-box",
		"../etc":       "coral-heavy-etc",
		"-oProxy=x":    "coral-heavy-oproxy-x", // never an option: the alias starts with coral-heavy-, and SSHArgs puts it after --
		"UPPER_lower9": "coral-heavy-upper-lower9",
	} {
		got, err := AliasFor(machine)
		require.NoError(t, err, machine)
		assert.Equal(t, want, got, machine)
		_, err = SSHArgs(got)
		assert.NoError(t, err, "%q is an alias SSHArgs accepts", got)
	}
}

// A grant that names no machine, or one that is nothing but punctuation, has no alias: no run is sent anywhere (Slug's "agent" fallback would have picked a destination).
func TestAliasForRefusesAGrantWithNoMachine(t *testing.T) {
	for _, machine := range []string{"", "   ", "---", "///", string(rune(0x202e))} {
		got, err := AliasFor(machine)
		assert.Error(t, err, "%q", machine)
		assert.Empty(t, got, "%q", machine)
	}
}

// A machine name too long for an ssh alias is refused by SSHArgs, not cut to a different machine's name.
func TestAnOverlongMachineNameIsRefusedNotCut(t *testing.T) {
	alias, err := AliasFor(strings.Repeat("a", 60))
	require.NoError(t, err)
	_, err = SSHArgs(alias)
	assert.Error(t, err)
}

// No code names the machine: the alias our setup uses lives in the ssh config the setup writes, not in a constant (#14354). A guard so the name does not come back in a product file.
func TestNoProductFileNamesTheOperatorsSshAlias(t *testing.T) {
	root := filepath.Join("..", "..")
	var hits []string
	require.NoError(t, filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		b, rerr := os.ReadFile(p)
		if rerr == nil && strings.Contains(string(b), "coral-heavy-mini") {
			hits = append(hits, p)
		}
		return nil
	}))
	assert.Empty(t, hits, "no product Go file names coral-heavy-mini")
}
