package testtemp

import "testing"

// OutsideTemp returns a new empty folder that is NOT inside the system temp folder, for a test of what Coral does with a path that is not temporary (agent.InTempFolder refuses a CLI there).
// It does what the tests used to do with a folder in the package's own source folder (nativehome-*, #13745), which another package's test walking the source tree could meet while it was made
// or removed ('open ../server/routes/nativehome-NNN: no such file' under go test -p 4, twice). The folder is a t.TempDir, like any other; what moves is the temp folder: TMPDIR, TMP and TEMP point to a
// second folder for the rest of the test (t.Setenv puts them back), so os.TempDir() no longer holds the first. A test that needs the real temp folder in that test again says so itself.
func OutsideTemp(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	other := t.TempDir() // made before the variables move, so it sits beside home
	t.Setenv("TMPDIR", other)
	t.Setenv("TMP", other)
	t.Setenv("TEMP", other)
	return home
}
