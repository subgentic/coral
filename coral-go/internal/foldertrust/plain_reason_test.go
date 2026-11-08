package foldertrust

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14601 (beta run 3): the row named the home-folder reasons for an ordinary folder that was refused for another reason. PlainReason says what kind of folder was refused, and "" for an error that is not a refusal of
// the folder (nothing specific is then said).
func TestPlainReasonNamesTheKindOfRefusalAndOnlyThat(t *testing.T) {
	home := t.TempDir()
	proj := filepath.Join(home, "work", "proj")
	require.NoError(t, os.MkdirAll(proj, 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".hidden", "x"), 0o755))
	_, err := Check(proj, home, Ticked)
	require.NoError(t, err, "an ordinary project folder under home is trusted when ticked")
	assert.Empty(t, PlainReason(nil))

	for name, c := range map[string]struct {
		path string
		want string
	}{
		"the home folder":            {home, plainHome},
		"a hidden folder":            {filepath.Join(home, ".hidden", "x"), plainHome},
		"a direct child of home":     {filepath.Join(home, "work"), plainHome},
		"a folder that is not there": {filepath.Join(home, "work", "gone"), plainFind},
		"a relative path":            {"work/proj", plainFind},
	} {
		_, err := Check(c.path, home, Ticked)
		require.Error(t, err, name)
		assert.Equal(t, c.want, PlainReason(err), name)
	}
	if runtime.GOOS != "windows" {
		open := filepath.Join(t.TempDir(), "wide")
		require.NoError(t, os.Mkdir(open, 0o777))
		require.NoError(t, os.Chmod(open, 0o777))
		other := t.TempDir()
		_, err := Check(open, other, Ticked) // outside the given home, and anyone can write into it (or it sits under a shared root)
		require.Error(t, err)
		assert.Equal(t, plainShared, PlainReason(err), "a shared or writable folder is not called a home folder")
	}
	assert.Empty(t, PlainReason(errors.New("the home folder is not known")), "an error that is not a refusal of the folder says nothing specific")
	assert.Empty(t, PlainReason(ErrNotTicked))
}
