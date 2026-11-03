package routes

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

// Only a person's Check again re-reads the saved Path (#457): an ordinary check, the Settings account Check and a check by path do not.
func TestOnlyCheckAgainReReadsTheSavedPath(t *testing.T) {
	prevLook, prevCommon, prevRefresh := cliLookPath, cliCommonPath, cliRefreshSavedPath
	t.Cleanup(func() { cliLookPath, cliCommonPath, cliRefreshSavedPath = prevLook, prevCommon, prevRefresh })
	cliLookPath = func(string) (string, error) { return "", errors.New("not found") }
	cliCommonPath = func(string) string { return "" }
	reads := 0
	cliRefreshSavedPath = func() int { reads++; return 0 }
	h := newSystemHandlerForTest(t)

	cliCheck(t, h, "type=codex")
	cliCheck(t, h, "type=claude&source=settings_check")
	assert.Zero(t, reads, "no Check again yet")

	out := cliCheck(t, h, "type=codex&source=cli_recheck")
	assert.Equal(t, 1, reads)
	assert.Equal(t, false, out["found"], "the re-read found nothing here: still not found")
}
