//go:build windows

package server

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/config"
)

// usersCanReadFolder gives dir the list of a folder on a drive root: this user, SYSTEM and BUILTIN\Users with read, inherited by what is in it.
func usersCanReadFolder(t *testing.T, dir string) {
	t.Helper()
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	require.NoError(t, err)
	out, err := exec.Command("icacls", dir, "/inheritance:r", "/grant:r", "*"+u.User.Sid.String()+":(OI)(CI)F", "/grant:r", "*S-1-5-18:(OI)(CI)F",
		"/grant:r", "*S-1-5-32-545:(OI)(CI)RX").CombinedOutput()
	require.NoError(t, err, string(out))
}

// The startup order, for real: a data folder that Users can read, holding an API key that inherits that list. EnsureDataDir makes the
// folder private and leaves its marker; the server then renews the key, the old key is refused, and the marker goes.
func TestTheStartupOrderRenewsTheKeyOfAFolderMadePrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "coral")
	require.NoError(t, os.Mkdir(dir, 0o700))
	usersCanReadFolder(t, dir)
	oldKey, _, _ := oldSecrets(t, dir)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "coral.log"), nil, 0o600)) // a file that marks the folder as Coral's (looksLikeCoralDataDir)
	groups, err := config.DataDirBroadReaders(filepath.Join(dir, "api_key"))
	require.NoError(t, err)
	require.NotEmpty(t, groups, "the setup: other accounts can read the key")
	t.Cleanup(func() {
		config.SetDataDirMadePrivate(dir, false)
		config.SetDataDirNotice("")
	})

	require.NoError(t, config.EnsureDataDir(dir))
	require.True(t, config.DataDirMadePrivate(dir), "EnsureDataDir made the folder private")
	require.FileExists(t, filepath.Join(dir, config.ExposedPendingFile), "and left its marker until the secrets are replaced")
	groups, err = config.DataDirBroadReaders(filepath.Join(dir, "api_key"))
	require.NoError(t, err)
	require.Empty(t, groups, "the key file is private now")
	still, err := auth.ReadAPIKey(dir)
	require.NoError(t, err)
	require.Equal(t, oldKey, still, "nothing has replaced it yet")

	srv, ts := openFolderServer(t, dir, asFound, nil)
	assert.NotEqual(t, oldKey, srv.keyStore.Key())
	assert.Equal(t, http.StatusUnauthorized, statusWithKey(t, ts, oldKey))
	assert.Equal(t, http.StatusOK, statusWithKey(t, ts, srv.keyStore.Key()))
	notice := config.DataDirNotice()
	assert.True(t, strings.HasPrefix(notice, "Coral made its data folder "+dir+" private to this user"), notice)
	assert.Contains(t, notice, "Coral replaced the API key")
	assert.NoFileExists(t, filepath.Join(dir, config.ExposedPendingFile), "replaced: the marker is gone")
}
