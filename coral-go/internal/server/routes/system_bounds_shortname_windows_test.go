//go:build windows

package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"
)

// shortOf is p's 8.3 short form (GetShortPathNameW); p itself where the volume has no short names (then there is no second spelling to get past the check with).
func shortOf(t *testing.T, p string) string {
	t.Helper()
	lp, err := windows.UTF16PtrFromString(p)
	require.NoError(t, err)
	buf := make([]uint16, 1024)
	n, err := windows.GetShortPathName(lp, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || int(n) > len(buf) {
		return p
	}
	return windows.UTF16ToString(buf[:n])
}

// #350 (Orchestrator, Security): a folder has two spellings on Windows, the long name and the 8.3 short one (C:\Users\LONGUS~1\AppData\Local\Temp), and a checked binary
// must be refused in a temporary folder whichever spelling reaches it, and whichever spelling the temp folder is given in. Run with the Go the release ships (1.26.10) and the
// newest: the comparison is of strings after EvalSymlinks, which expands short names on 1.27.3.
func TestCLICheckRefusesABinaryInATempFolderBySpellingOfEitherPath(t *testing.T) {
	h := newSystemHandlerForTest(t)
	script, marker := markerCLI(t, systemTempFolder(t), "claude")
	short := shortOf(t, script)
	t.Logf("binary: %s\n  by its short name: %s", script, short)

	// The binary reached by its short path, the temp folder as the system names it.
	assert.Equal(t, "in a temporary folder", h.untrustedLocation(t.Context(), short))
	rec := cliCheckAs(h, "binary="+short, asOperator)
	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())

	// The temp folder given in its short form (TEMP and TMP), the binary by its long path.
	shortTemp := shortOf(t, os.TempDir())
	t.Setenv("TMP", shortTemp)
	t.Setenv("TEMP", shortTemp)
	require.Equal(t, filepath.Clean(shortTemp), filepath.Clean(os.TempDir()), "os.TempDir follows TEMP")
	assert.Equal(t, "in a temporary folder", h.untrustedLocation(t.Context(), script))
	assert.Equal(t, "in a temporary folder", h.untrustedLocation(t.Context(), short))
	rec = cliCheckAs(h, "binary="+script, asOperator)
	assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	assert.NoFileExists(t, marker, "nothing was run")
}
