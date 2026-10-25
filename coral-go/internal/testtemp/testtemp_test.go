package testtemp

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUsePointsTheTempFolderAtANewFolderAndRemovesIt(t *testing.T) {
	before := map[string]string{}
	for _, k := range []string{"TMPDIR", "TMP", "TEMP", "HOME", "USERPROFILE", "CORAL_DATA_DIR", "GOCACHE", "GOPATH", "GOMODCACHE", "GOENV"} {
		before[k] = os.Getenv(k)
	}
	t.Cleanup(func() {
		for k, v := range before {
			os.Setenv(k, v)
		}
	})
	cleanup := Use()
	dir := os.TempDir()
	require.NotEqual(t, before["TMP"], os.Getenv("TMP"))
	dir = filepath.Clean(dir)
	for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
		assert.Equal(t, os.Getenv("TMP"), os.Getenv(k), k)
	}
	root := filepath.Dir(dir)
	assert.Equal(t, filepath.Join(root, "home"), os.Getenv("HOME"))
	assert.Equal(t, filepath.Join(root, "home"), os.Getenv("USERPROFILE"))
	assert.Equal(t, filepath.Join(root, "coral-data"), os.Getenv("CORAL_DATA_DIR"))
	home, err := os.UserHomeDir()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(root, "home"), home, "no test reaches the person's real home or ~/.coral")
	assert.NotEmpty(t, os.Getenv("GOCACHE"), "the Go tool keeps its build cache, so a test that builds is not cold")
	out, err := exec.Command("go", "env", "GOCACHE", "GOPATH", "GOMODCACHE").Output()
	require.NoError(t, err)
	want := strings.Fields(string(out)) // what go itself answers inside the private home: the same places as before
	require.Len(t, want, 3)
	assert.Equal(t, want[0], os.Getenv("GOCACHE"))
	assert.Equal(t, want[1], os.Getenv("GOPATH"))
	assert.Equal(t, want[2], os.Getenv("GOMODCACHE"))
	f, err := os.CreateTemp("", "x")
	require.NoError(t, err)
	f.Close()
	assert.Equal(t, filepath.Clean(dir), filepath.Dir(f.Name()), "new temp files land in the private folder")
	cleanup()
	_, err = os.Stat(root)
	assert.True(t, os.IsNotExist(err), "the folder is removed")
}
