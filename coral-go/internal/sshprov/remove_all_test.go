//go:build !windows

package sshprov

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12263: "also delete its data" runs CmdRemoveAll on the far computer. It deletes the install folder of a Coral set up here and nothing else: not a link (whatever it points at), not a folder that has no instance id
// of ours (another program's, or a folder that only has the name), and a folder that is not there is already gone. The template is run by a real shell with HOME in a temp folder.
func runRemoveAll(t *testing.T, home string) int {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", specs[CmdRemoveAll].template)
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	err := cmd.Run()
	if err == nil {
		return 0
	}
	ee, ok := err.(*exec.ExitError)
	require.True(t, ok, "%v", err)
	return ee.ExitCode()
}

func TestRemoveAllDeletesTheInstallFolderOfACoralSetUpHere(t *testing.T) {
	home := t.TempDir()
	install := filepath.Join(home, InstallDir)
	require.NoError(t, os.MkdirAll(filepath.Join(install, "data"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(install, "instance-id"), []byte("0123456789abcdef0123456789abcdef\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(install, "data", "api_key"), []byte("k"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(home, "keep.txt"), []byte("mine"), 0o600))
	assert.Zero(t, runRemoveAll(t, home))
	_, err := os.Lstat(install)
	assert.True(t, os.IsNotExist(err), "the folder, its data and its instance id are gone")
	_, err = os.Stat(filepath.Join(home, "keep.txt"))
	assert.NoError(t, err, "nothing else of the home")
}

func TestRemoveAllNeverRemovesALinkOrAFolderThatIsNotOurs(t *testing.T) {
	t.Run("the install folder is a link: the link and what it points at stay", func(t *testing.T) {
		home := t.TempDir()
		target := filepath.Join(t.TempDir(), "precious")
		require.NoError(t, os.MkdirAll(target, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(target, "instance-id"), []byte("0123456789abcdef0123456789abcdef\n"), 0o600))
		require.NoError(t, os.WriteFile(filepath.Join(target, "mine.txt"), []byte("x"), 0o600))
		require.NoError(t, os.Symlink(target, filepath.Join(home, InstallDir)))
		assert.Equal(t, 7, runRemoveAll(t, home), "refused, with its own code")
		_, err := os.Stat(filepath.Join(target, "mine.txt"))
		assert.NoError(t, err, "what the link points at is untouched")
		fi, err := os.Lstat(filepath.Join(home, InstallDir))
		require.NoError(t, err)
		assert.NotZero(t, fi.Mode()&os.ModeSymlink, "and so is the link")
	})
	t.Run("a folder with the name and no instance id: another program's", func(t *testing.T) {
		home := t.TempDir()
		install := filepath.Join(home, InstallDir)
		require.NoError(t, os.MkdirAll(install, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(install, "notes.txt"), []byte("not coral"), 0o600))
		assert.Equal(t, 7, runRemoveAll(t, home))
		_, err := os.Stat(filepath.Join(install, "notes.txt"))
		assert.NoError(t, err)
	})
	t.Run("the instance id is a link", func(t *testing.T) {
		home := t.TempDir()
		install := filepath.Join(home, InstallDir)
		require.NoError(t, os.MkdirAll(install, 0o700))
		other := filepath.Join(t.TempDir(), "id")
		require.NoError(t, os.WriteFile(other, []byte("0123456789abcdef0123456789abcdef\n"), 0o600))
		require.NoError(t, os.Symlink(other, filepath.Join(install, "instance-id")))
		require.NoError(t, os.WriteFile(filepath.Join(install, "notes.txt"), []byte("x"), 0o600))
		assert.Equal(t, 7, runRemoveAll(t, home))
		_, err := os.Stat(filepath.Join(install, "notes.txt"))
		assert.NoError(t, err)
	})
	t.Run("a plain file with the name", func(t *testing.T) {
		home := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(home, InstallDir), []byte("x"), 0o600))
		assert.Equal(t, 7, runRemoveAll(t, home))
		_, err := os.Stat(filepath.Join(home, InstallDir))
		assert.NoError(t, err)
	})
	t.Run("nothing there: already gone", func(t *testing.T) {
		assert.Zero(t, runRemoveAll(t, t.TempDir()))
	})
	t.Run("no home: nothing is touched", func(t *testing.T) {
		assert.NotZero(t, runRemoveAll(t, ""))
	})
}
