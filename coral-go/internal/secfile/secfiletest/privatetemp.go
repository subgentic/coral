package secfiletest

import (
	"os"
	"runtime"
)

// UsePrivateTemp, called from a TestMain, gives the test binary a temp folder with a protected,
// owner-only access list that the files made in it inherit (protectInheritable), and points TMP
// and TEMP at it (Windows), so every t.TempDir() is made inside it. A secret file a test makes then has this user's own access only, whatever the real
// %TEMP% grants: Codex's Windows sandbox adds a Modify entry for its capability SID to every
// writable root it is given (the user's %TEMP% among them), and Coral's private-file checks
// rightly refuse a file that inherits it (#28). The returned func removes the folder. Elsewhere
// it does nothing: Unix files take their mode, not their folder's.
func UsePrivateTemp() (cleanup func()) {
	if runtime.GOOS != "windows" {
		return func() {}
	}
	dir, err := os.MkdirTemp("", "coral-private-test-")
	if err != nil {
		return func() {}
	}
	if err := protectInheritable(dir); err != nil {
		os.RemoveAll(dir)
		return func() {}
	}
	os.Setenv("TMP", dir)
	os.Setenv("TEMP", dir)
	// t.TempDir() makes its folders in GOTMPDIR when that is set (testtemp sets it, and a runner on another volume does), not in TEMP: it would then step around the protected
	// folder, and a secret file a test makes would inherit the other folder's access list (#190, folded into #177).
	if os.Getenv("GOTMPDIR") != "" {
		os.Setenv("GOTMPDIR", dir)
	}
	return func() { os.RemoveAll(dir) }
}
