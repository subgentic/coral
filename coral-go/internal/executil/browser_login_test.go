package executil

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12546 (Security #3970, point 5): the sign-in link is the one secret in a browser launch, and an argument list is readable by every account on the computer. OpenLogin gives the opener a file
// (owner-only, it redirects to the link) and never the link; a plain address, or a file that cannot be written, goes the old way.
func TestOpenLoginKeepsTheLinkOutOfTheArgumentList(t *testing.T) {
	var started [][]string
	t.Cleanup(setOpenerForTest(func(argv []string) bool { started = append(started, argv); return true }))
	t.Setenv("TMPDIR", t.TempDir()) // the page is written under it
	t.Setenv("TEMP", os.Getenv("TMPDIR"))
	t.Setenv("TMP", os.Getenv("TMPDIR"))

	link := "http://127.0.0.1:8420/?login_token=0123456789abcdef0123456789abcdef&next=%2Fa%3Fb%3D1"
	OpenLogin(link)
	require.Len(t, started, 1)
	for _, a := range started[0] {
		assert.NotContains(t, a, "login_token", "the secret is not in the opener's argument list: %v", started[0])
		assert.NotContains(t, a, "0123456789abcdef")
	}
	path := started[0][len(started[0])-1]
	assert.True(t, strings.HasSuffix(path, ".html"), path)
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	page := string(b)
	assert.Contains(t, page, `http-equiv="refresh"`)
	assert.Contains(t, page, `content="0;url=http://127.0.0.1:8420/?login_token=0123456789abcdef0123456789abcdef&amp;next=%2Fa%3Fb%3D1"`, "the link, escaped for an attribute")
	assert.Contains(t, page, `name="referrer" content="no-referrer"`)
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		require.NoError(t, err)
		assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm(), "only its owner can read the page")
	}

	// an address with no secret in it is opened as before
	started = nil
	OpenLogin("http://localhost:8420")
	require.Len(t, started, 1)
	assert.Equal(t, "http://localhost:8420", started[0][len(started[0])-1])

	// not a web address: not opened at all
	started = nil
	OpenLogin("file:///etc/passwd?login_token=x")
	OpenLogin("javascript:alert(1)")
	assert.Empty(t, started)
}

// The opener's command names the file, per system, and the page never holds anything but the redirect.
func TestLoginPageOpenerCommands(t *testing.T) {
	assert.Equal(t, []string{"open", "/tmp/p.html"}, fileOpenCommand("darwin", "/tmp/p.html"))
	assert.Equal(t, []string{"xdg-open", "/tmp/p.html"}, fileOpenCommand("linux", "/tmp/p.html"))
	w := fileOpenCommand("windows", `C:\t\p.html`)
	assert.Equal(t, []string{"url.dll,FileProtocolHandler", `C:\t\p.html`}, w[len(w)-2:])
}

// A sign-in link is opened with OpenLogin, never OpenBrowser: a caller that builds a link with loginlink or a mint function and hands it to OpenBrowser puts the secret in the opener's argument list
// again (#12546). Counted in every program's source.
func TestNoProgramOpensASignInLinkWithOpenBrowser(t *testing.T) {
	var offenders []string
	root := filepath.Join("..", "..", "cmd")
	require.NoError(t, filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(b), "\n") {
			if strings.Contains(line, "OpenBrowser(") && (strings.Contains(line, "loginlink.") || strings.Contains(line, "mintLink") || strings.Contains(line, "login_token")) && !strings.Contains(line, "OpenLogin(") {
				offenders = append(offenders, path+":"+strconv.Itoa(i+1))
			}
		}
		return nil
	}))
	assert.Empty(t, offenders, "a sign-in link goes to executil.OpenLogin")
}
