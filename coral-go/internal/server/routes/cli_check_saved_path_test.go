package routes

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/agent"
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

// A common place on a network share that did not answer (#464): the not-found answer adds the one fixed sentence, which names no folder.
func TestCLICheckSaysAShareDidNotAnswer(t *testing.T) {
	prevLook, prevCommon, prevSkipped := cliLookPath, cliCommonPath, cliShareSkipped
	t.Cleanup(func() { cliLookPath, cliCommonPath, cliShareSkipped = prevLook, prevCommon, prevSkipped })
	cliLookPath = func(string) (string, error) { return "", errors.New("not found") }
	cliCommonPath = func(string) string { return "" }
	h := newSystemHandlerForTest(t)

	cliShareSkipped = func(string) bool { return false }
	out := cliCheck(t, h, "type=codex")
	note, _ := out["install_note"].(string)
	assert.NotContains(t, note, "network share")

	cliShareSkipped = func(string) bool { return true }
	out = cliCheck(t, h, "type=codex")
	assert.Equal(t, false, out["found"])
	assert.Contains(t, out["install_note"], agent.ShareNotAnsweredNote("codex"))
}

// The sentence names the CLI by its fixed name, never the file name of a path set in Settings (Security's INFO 2 on #295).
func TestTheShareSentenceNamesTheCLINotACustomPath(t *testing.T) {
	tools := filepath.Join(t.TempDir(), "tools") // this OS's own separator: the test is the same on Windows, macOS and Linux
	note := cliShareNote("claude", filepath.Join(tools, "my-claude-wrapper.exe"))
	assert.Contains(t, note, "looks for claude is")
	assert.NotContains(t, note, "my-claude-wrapper")
	assert.NotContains(t, note, tools)
	assert.Contains(t, cliShareNote("", filepath.Join(tools, "thing.exe")), "looks for thing.exe is", "a check by path with no known type names the file the person gave")
}
