package heavy

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13750, Security's MUST 3: the run folder is Root/<agent>/<run>, both parts checked, built in one place; the cleanup removes exactly that folder and never follows a link out of the root; the root is private; a janitor removes
// folders older than a day.

func TestTheRunFolderIsBuiltInOnePlaceAndBothPartsAreChecked(t *testing.T) {
	root := t.TempDir()
	d, err := RunDir(root, "lead-developer", "0123456789abcdef0123456789abcdef")
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(root, "lead-developer", "0123456789abcdef0123456789abcdef"), d)
	for _, bad := range [][2]string{
		{"", "0123456789abcdef0123456789abcdef"}, {"agent", ""}, {"a/b", "0123456789abcdef0123456789abcdef"}, {"agent", "../0123456789abcdef"}, {"..", "0123456789abcdef0123456789abcdef"},
		{"agent", "0123456789abcdef"}, {"agent", "0123456789ABCDEF0123456789ABCDEF"}, {"agent", "0123456789abcdeg0123456789abcdef"}, {"agent", "0123456789abcdef0123456789abcdef0"}, {"Agent Name", "0123456789abcdef0123456789abcdef"}, {"-x", "0123456789abcdef0123456789abcdef"},
		{"agent\x00", "0123456789abcdef0123456789abcdef"}, {"agent", "0123456789abcdef\n"},
	} {
		_, err := RunDir(root, bad[0], bad[1])
		assert.ErrorIs(t, err, ErrBadRun, "%q %q", bad[0], bad[1])
	}
}

func TestTheRootIsMadePrivateAndTheCleanupRemovesExactlyOneRunFolder(t *testing.T) {
	root := filepath.Join(t.TempDir(), "coral-test")
	d, err := MakeRunDir(root, "dev", "0123456789abcdef0123456789abcdef")
	require.NoError(t, err)
	fi, err := os.Stat(root)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o700), fi.Mode().Perm(), "the root is 0700")
	other, err := MakeRunDir(root, "dev", "fedcba9876543210fedcba9876543210")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(d, "f"), []byte("x"), 0o600))
	require.NoError(t, RemoveRun(root, "dev", "0123456789abcdef0123456789abcdef"))
	_, err = os.Stat(d)
	assert.True(t, os.IsNotExist(err), "the run folder is gone")
	_, err = os.Stat(other)
	assert.NoError(t, err, "a sibling run is untouched")
	assert.ErrorIs(t, RemoveRun(root, "dev", ""), ErrBadRun)
	assert.ErrorIs(t, RemoveRun(root, "../dev", "fedcba9876543210fedcba9876543210"), ErrBadRun)
	_, err = os.Stat(other)
	assert.NoError(t, err)
}

func TestAFolderThatAlreadyExistsIsNeverReusedSoAStreamCannotWriteIntoAnotherRun(t *testing.T) {
	root := filepath.Join(t.TempDir(), "coral-test")
	_, err := MakeRunDir(root, "dev", "0123456789abcdef0123456789abcdef")
	require.NoError(t, err)
	_, err = MakeRunDir(root, "dev", "0123456789abcdef0123456789abcdef")
	assert.ErrorIs(t, err, ErrExists, "a plain mkdir that fails when the run folder is there")
}

func TestTheCleanupNeverFollowsALinkOutOfTheRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "coral-test")
	outside := t.TempDir()
	keep := filepath.Join(outside, "precious")
	require.NoError(t, os.WriteFile(keep, []byte("do not delete"), 0o600))
	_, err := MakeRunDir(root, "dev", "0123456789abcdef0123456789abcdef")
	require.NoError(t, err)
	// the run folder replaced by a link to somewhere outside the root
	run := filepath.Join(root, "dev", "0123456789abcdef0123456789abcdef")
	require.NoError(t, os.RemoveAll(run))
	require.NoError(t, os.Symlink(outside, run))
	assert.Error(t, RemoveRun(root, "dev", "0123456789abcdef0123456789abcdef"), "a link in place of the run folder is refused")
	_, err = os.Stat(keep)
	assert.NoError(t, err, "nothing outside the root was touched")
	// the agent folder itself a link
	require.NoError(t, os.Remove(run))
	require.NoError(t, os.RemoveAll(filepath.Join(root, "dev")))
	require.NoError(t, os.Symlink(outside, filepath.Join(root, "dev")))
	assert.Error(t, RemoveRun(root, "dev", "0123456789abcdef0123456789abcdef"))
	_, err = MakeRunDir(root, "dev", "0123456789abcdef0123456789abcdef")
	assert.Error(t, err, "and nothing is made through it either")
	_, err = os.Stat(keep)
	assert.NoError(t, err)
}

func TestTheJanitorRemovesRunFoldersOlderThanADayAndNothingElse(t *testing.T) {
	root := filepath.Join(t.TempDir(), "coral-test")
	old, err := MakeRunDir(root, "dev", "0123456789abcdef0123456789abcdef")
	require.NoError(t, err)
	fresh, err := MakeRunDir(root, "dev", "fedcba9876543210fedcba9876543210")
	require.NoError(t, err)
	stray := filepath.Join(root, "dev", "not-a-run")
	require.NoError(t, os.MkdirAll(stray, 0o700)) // not a name Coral makes: left alone
	long := time.Now().Add(-26 * time.Hour)
	require.NoError(t, os.Chtimes(old, long, long))
	require.NoError(t, os.Chtimes(stray, long, long))
	n := Janitor(root, time.Now(), 24*time.Hour)
	assert.Equal(t, 1, n)
	_, err = os.Stat(old)
	assert.True(t, os.IsNotExist(err))
	_, err = os.Stat(fresh)
	assert.NoError(t, err)
	_, err = os.Stat(stray)
	assert.NoError(t, err, "only folders of the form Coral makes are removed")
}
