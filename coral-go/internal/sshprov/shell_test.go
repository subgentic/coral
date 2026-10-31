package sshprov

import (
	"runtime"
	"testing"
)

// needShell skips a test that stands a POSIX shell script in for ssh (or for the far computer, which is sh, tar and sha256sum): there is no such script on Windows. SSH setup from a Windows hub is not
// tested by these tests, and the release notes do not claim it (v2.0.10, #138388).
func needShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake ssh and the far computer are POSIX shell scripts: SSH setup from a Windows hub is not covered by these tests")
	}
}

// permsApply is false where file modes are not Unix permissions (Windows reports 0666 or 0777 whatever the code asks for), so a test of a 0600 or 0700 file checks the mode only where it means something.
// On Windows the product relies on the folder's inherited ACL instead: ~/.ssh and the user's temp folder are inside the user's profile, which only that user and administrators can read.
func permsApply() bool { return runtime.GOOS != "windows" }
