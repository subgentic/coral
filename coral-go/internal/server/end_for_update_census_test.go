package server

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9760: a build must not ship the relaunch (updateRelaunchFeature on) with the updater ended by a plain SIGTERM, which a tray-supervised server takes as a clean stop (the tray stays, the updater waits for it, nothing is
// swapped, nothing restarts). The feature is a compile-time false today; this census fails the day the relaunch updater is built with anything but endForUpdate, or something else ends the server for an update.
func TestTheRelaunchUpdaterIsEndedByEndForUpdateAndNothingElse(t *testing.T) {
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)
	callRe := regexp.MustCompile(`(?s)routes\.BuildRelaunchUpdater\((.*?)\)\n`)
	builds, ends := 0, 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		require.NoError(t, err)
		src := string(b)
		for _, m := range callRe.FindAllStringSubmatch(src, -1) {
			builds++
			assert.Contains(t, m[1], "s.endForUpdate(endThisServer)", "%s: the relaunch updater must be built with a quit that is endForUpdate: %s", f, strings.TrimSpace(m[0]))
			assert.NotRegexp(t, `, endThisServer\)\s*$`, strings.TrimSpace(m[0]), "%s: a bare endThisServer", f)
		}
		if f == "end_server_unix.go" || f == "end_server_windows.go" {
			continue // the definitions
		}
		ends += strings.Count(src, "endThisServer")
	}
	assert.Equal(t, 1, builds, "exactly one place builds the relaunch updater (router.go)")
	assert.Equal(t, 1, ends, "endThisServer appears once outside its definitions: as endForUpdate's fallback argument")
}
