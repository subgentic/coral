package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func hookName() string {
	if runtime.GOOS == "windows" {
		return "coral-hook-agentic-state.exe"
	}
	return "coral-hook-agentic-state"
}

// The executable's real path is resolved once and remembered; the stat of the hook binary still happens on every call. When the remembered folder stops holding the hook
// (a package manager replaced the binary and moved the link it was reached by), the next call drops the memory and resolves the new place, once.
func TestExecutablePathIsRememberedAndResolvedAgainWhenTheHookIsGone(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	for _, d := range []string{a, b} {
		require.NoError(t, os.WriteFile(filepath.Join(d, "coral"), nil, 0o755)) // EvalSymlinks needs the file to exist
	}
	require.NoError(t, os.WriteFile(filepath.Join(a, hookName()), nil, 0o755))
	current := a
	calls := 0
	r := &exeResolver{exe: func() (string, error) { calls++; return filepath.Join(current, "coral"), nil }}

	realA, err := filepath.EvalSymlinks(a)
	require.NoError(t, err)
	require.Equal(t, realA, appBundleBinDirFor(r))
	require.Equal(t, realA, appBundleBinDirFor(r))
	require.Equal(t, 1, calls, "the second call used the memory")

	// the move: the hook is no longer where it was remembered, and the executable is now reached in b
	require.NoError(t, os.Remove(filepath.Join(a, hookName())))
	require.NoError(t, os.WriteFile(filepath.Join(b, hookName()), nil, 0o755))
	current = b
	realB, err := filepath.EvalSymlinks(b)
	require.NoError(t, err)
	require.Equal(t, realB, appBundleBinDirFor(r), "the stat failed, the memory was dropped and the path resolved fresh")
	require.Equal(t, 2, calls)
	require.Equal(t, realB, appBundleBinDirFor(r))
	require.Equal(t, 2, calls, "and the new place is remembered")
}

// A resolve that fails is not remembered, and a folder with no hook binary is not returned.
func TestExecutablePathFailureIsNotRemembered(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "coral"), nil, 0o755))
	fail := true
	calls := 0
	r := &exeResolver{exe: func() (string, error) {
		calls++
		if fail {
			return "", os.ErrNotExist
		}
		return filepath.Join(dir, "coral"), nil
	}}
	require.Empty(t, appBundleBinDirFor(r))
	require.Empty(t, appBundleBinDirFor(r))
	require.Equal(t, 2, calls, "each call after a failure resolves again")
	fail = false
	require.Empty(t, appBundleBinDirFor(r), "a folder without the hook is not a tools folder")
	require.Empty(t, boardOnlyDirFor(r))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "coral-board"), nil, 0o755))
	real, err := filepath.EvalSymlinks(dir)
	require.NoError(t, err)
	require.Equal(t, real, boardOnlyDirFor(r), "coral-board appears later in the remembered folder: the per-call stat sees it")
}

// A macOS .app bundle that is moved while Coral runs: the remembered bundle folder is stat'd, and when it is gone the path is resolved fresh (the new place, or nothing).
func TestBundleFolderIsCheckedBeforeItIsReturnedFromMemory(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "one", "Coral.app", "Contents", "MacOS")
	second := filepath.Join(root, "two", "Coral.app", "Contents", "MacOS")
	for _, d := range []string{first, second} {
		require.NoError(t, os.MkdirAll(d, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(d, "coral"), nil, 0o755))
	}
	current := first
	calls := 0
	r := &exeResolver{exe: func() (string, error) { calls++; return filepath.Join(current, "coral"), nil }}
	realFirst, err := filepath.EvalSymlinks(first)
	require.NoError(t, err)
	require.Equal(t, realFirst, appBundleBinDirFor(r))
	require.Equal(t, realFirst, appBundleBinDirFor(r))
	require.Equal(t, 1, calls, "the bundle folder came from the memory while it exists")

	// the bundle is moved: the remembered folder is gone and the executable is now reached in the second place
	require.NoError(t, os.RemoveAll(filepath.Join(root, "one")))
	current = second
	realSecond, err := filepath.EvalSymlinks(second)
	require.NoError(t, err)
	require.Equal(t, realSecond, appBundleBinDirFor(r), "the stat failed, the memory was dropped and the new bundle resolved")
	require.Equal(t, 2, calls)

	// and moved away with nothing left: a fresh resolve fails, and nothing is returned
	require.NoError(t, os.RemoveAll(filepath.Join(root, "two")))
	require.Empty(t, appBundleBinDirFor(r))
}
