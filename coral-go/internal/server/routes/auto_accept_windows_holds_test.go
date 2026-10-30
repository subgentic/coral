package routes

import (
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
)

// On Windows shellRisk also reads a command the way PowerShell and cmd do (winVerbRisk), and that reading is deliberately coarser than the POSIX one: it holds
// a command when a path argument is not provably inside the folder, with no model of tar's cumulative -C, of tar -c reading (not writing) from its -C folder, or
// of find's `\;` terminator (a backslash is a path separator there); and it holds a bash `case ... )`, whose arm bracket it can't pair (listed in the
// compound-form test). A hold is the safe side, never a miss, so the POSIX tests' "ordinary command passes" lines are not true on Windows for these commands.
// They are not skipped there (#350): each is asserted to be held by that layer, with its own reason, so a new over-block, or one that goes away, fails the
// test and the list is edited on purpose.
var windowsLayerHolds = map[string]string{
	`find . -execdir cp {} backup \;`: `it writes outside the working directory (\)`,
	`find sub -execdir rm -rf x \;`:   `it deletes recursively outside the working directory (\)`,
	`tar -xf a.tar -C sub -C ..`:      "it extracts outside the working directory (..)",
	`tar -cf out.tar -C /etc x`:       "it extracts outside the working directory (/etc)",
}

// assertOrdinaryPasses asserts that shellRisk holds nothing for an ordinary command: on POSIX always, on Windows unless the command is in holds, where the hold
// the Windows layer makes is the assertion.
func assertOrdinaryPasses(t *testing.T, got, command string, holds map[string]string, msg string) {
	t.Helper()
	if want, ok := holds[command]; ok && runtime.GOOS == "windows" {
		assert.Contains(t, got, want, "the Windows layer holds this one (%s): %s", msg, command)
		return
	}
	assert.Empty(t, got, "%s: %s", msg, command)
}
