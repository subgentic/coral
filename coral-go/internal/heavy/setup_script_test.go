//go:build !windows

package heavy

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Operator's one-time setup of the restricted account on the mini (tools/heavy/mini-setup.sh, Security's SHOULD 5): run in a throwaway HOME, it writes ONE authorized_keys line with restrict and a forced command,
// makes private folders and refuses anything that is not a plain public key.

const goodKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UdARxGkQ8MRvGwHBVQ1jQkS4FOYn coral-heavy"

func runSetup(t *testing.T, home string, args ...string) (string, error) {
	t.Helper()
	script, err := filepath.Abs("../../../tools/heavy/mini-setup.sh")
	require.NoError(t, err)
	cmd := exec.Command("bash", append([]string{script}, args...)...)
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "LANG=C"}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func fakeWrapper(t *testing.T) string {
	p := filepath.Join(t.TempDir(), "coral-heavy-run")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	return p
}

func TestSetupWritesOneRestrictedKeyLinePrivateFoldersAndTheWrapper(t *testing.T) {
	home := t.TempDir()
	out, err := runSetup(t, home, "--pubkey", goodKey, "--wrapper", fakeWrapper(t), "--skip-toolchains")
	require.NoError(t, err, out)
	raw, err := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	require.Len(t, lines, 1)
	assert.Equal(t, `restrict,command="`+home+`/bin/coral-heavy-run" `+goodKey, lines[0], "the key can run the wrapper and nothing else")
	for path, mode := range map[string]os.FileMode{".ssh": 0o700, ".ssh/authorized_keys": 0o600, "coral-test": 0o700, "bin": 0o700, "bin/coral-heavy-run": 0o500} {
		fi, err := os.Stat(filepath.Join(home, path))
		require.NoError(t, err, path)
		assert.Equal(t, mode, fi.Mode().Perm(), path)
	}
	assert.Contains(t, out, "Host coral-heavy-mini", "it prints the ssh config block for the Operator's Mac")
	assert.Contains(t, out, "StrictHostKeyChecking yes")
	assert.Contains(t, out, "ssh-keygen -lf", "and how to check the host key")
	// run again: still one line (it replaces its own, never doubles)
	_, err = runSetup(t, home, "--pubkey", goodKey, "--wrapper", fakeWrapper(t), "--skip-toolchains")
	require.NoError(t, err)
	raw, _ = os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	assert.Equal(t, 1, strings.Count(string(raw), "coral-heavy-run"))
}

func TestSetupKeepsOtherKeysAndRefusesAKeyThatIsNotAPlainPublicKey(t *testing.T) {
	home := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".ssh"), 0o700))
	other := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKeyOtherKe someone-else"
	require.NoError(t, os.WriteFile(filepath.Join(home, ".ssh", "authorized_keys"), []byte(other+"\n"), 0o600))
	_, err := runSetup(t, home, "--pubkey", goodKey, "--wrapper", fakeWrapper(t), "--skip-toolchains")
	require.NoError(t, err)
	raw, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	assert.Contains(t, string(raw), "someone-else", "another key is left alone")
	for _, bad := range []string{
		`command="touch /tmp/x" ` + goodKey,
		goodKey + "\nssh-ed25519 AAAAevil",
		"ssh-rsa AAAAB3NzaC1yc2E short",
		`ssh-ed25519 AAAA" ; echo pwned #`,
		"",
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UdARxGkQ8MRvGwHBVQ1jQkS4FOYn comment with spaces and, options",
	} {
		h2 := t.TempDir()
		_, err := runSetup(t, h2, "--pubkey", bad, "--wrapper", fakeWrapper(t), "--skip-toolchains")
		assert.Error(t, err, "%q", bad)
		_, statErr := os.Stat(filepath.Join(h2, ".ssh", "authorized_keys"))
		assert.True(t, os.IsNotExist(statErr), "nothing is written for %q", bad)
	}
}

func TestSetupDryRunWritesNothingAndRefusesToRunAsRoot(t *testing.T) {
	home := t.TempDir()
	out, err := runSetup(t, home, "--pubkey", goodKey, "--wrapper", fakeWrapper(t), "--skip-toolchains", "--dry-run")
	require.NoError(t, err, out)
	entries, _ := os.ReadDir(home)
	assert.Empty(t, entries, "a dry run writes nothing")
	assert.Contains(t, out, "would")
	if os.Geteuid() != 0 {
		return
	}
	_, err = runSetup(t, home, "--pubkey", goodKey, "--wrapper", fakeWrapper(t), "--skip-toolchains")
	assert.Error(t, err, "root is refused")
}
