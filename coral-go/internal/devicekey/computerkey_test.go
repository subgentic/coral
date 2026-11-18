package devicekey_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
)

func TestComputerKeyIsMadeOnceAndKept(t *testing.T) {
	dir := t.TempDir()
	a, err := devicekey.LoadOrCreateComputerKey(dir)
	require.NoError(t, err)
	assert.Len(t, a.Pub(), 32)
	assert.Equal(t, devicekey.ComputerFingerprint(a.Pub()), a.Computer())
	b, err := devicekey.LoadOrCreateComputerKey(dir)
	require.NoError(t, err)
	assert.Equal(t, a.Pub(), b.Pub(), "the same key after a restart")
	other, err := devicekey.LoadOrCreateComputerKey(t.TempDir())
	require.NoError(t, err)
	assert.NotEqual(t, a.Pub(), other.Pub())
}

func TestComputerKeyFileIsOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits")
	}
	dir := t.TempDir()
	_, err := devicekey.LoadOrCreateComputerKey(dir)
	require.NoError(t, err)
	fi, err := os.Stat(filepath.Join(dir, devicekey.ComputerKeyFile))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	require.NoError(t, os.Chmod(filepath.Join(dir, devicekey.ComputerKeyFile), 0o644))
	_, err = devicekey.LoadOrCreateComputerKey(dir)
	assert.ErrorIs(t, err, devicekey.ErrComputerKeyFile, "a key file others can read is refused, not used")
}

func TestComputerKeyRefusesALinkOrAWrongFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "elsewhere")
	require.NoError(t, os.WriteFile(target, []byte(strings.Repeat("A", 43)+"\n"), 0o600))
	require.NoError(t, os.Symlink(target, filepath.Join(dir, devicekey.ComputerKeyFile)))
	_, err := devicekey.LoadOrCreateComputerKey(dir)
	assert.ErrorIs(t, err, devicekey.ErrComputerKeyFile)

	dir2 := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir2, devicekey.ComputerKeyFile), []byte("not a key"), 0o600))
	_, err = devicekey.LoadOrCreateComputerKey(dir2)
	assert.ErrorIs(t, err, devicekey.ErrComputerKeyFile, "a damaged file is never silently replaced: that would change the computer's identity")
	assert.NotContains(t, err.Error(), "not a key")
}

// Lead Q2: only the key package touches the key file. A scan of every other non-test source file for its name.
func TestOnlyTheKeyPackageNamesTheKeyFile(t *testing.T) {
	var hits []string
	root := filepath.Join("..", "..")
	require.NoError(t, filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		if strings.Contains(filepath.ToSlash(p), "internal/devicekey/") {
			return nil
		}
		b, _ := os.ReadFile(p)
		if strings.Contains(string(b), devicekey.ComputerKeyFile) || strings.Contains(string(b), "ComputerKeyFile") {
			hits = append(hits, p)
		}
		return nil
	}))
	assert.Empty(t, hits)
}
