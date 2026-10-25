//go:build windows

package linktest

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
)

// errUntrustedMountPoint is ERROR_UNTRUSTED_MOUNT_POINT, "The path cannot be traversed because it contains an untrusted mount point.": since Windows 11
// build 26300 the system itself refuses to open a path that goes through a directory junction, whoever made it and wherever it leads.
const errUntrustedMountPoint syscall.Errno = 448

// UntrustedMountPoint reports whether err is Windows refusing to traverse a junction.
func UntrustedMountPoint(err error) bool { return errors.Is(err, errUntrustedMountPoint) }

var (
	probeOnce sync.Once
	probeOK   bool
	probeErr  error
)

// JunctionsTraversable reports whether this Windows lets a program open a file through a junction. The tests of Coral's own junction handling have two
// honest outcomes (#350): where it does, Coral's layer decides and refuses a junction out of the root; where it does not, the system refuses first, and the
// test asserts that refusal (UntrustedMountPoint) instead. The tests say which layer refused; none is skipped.
func JunctionsTraversable(t *testing.T) bool {
	t.Helper()
	probeOnce.Do(func() {
		dir, err := os.MkdirTemp("", "junction-probe-")
		if err != nil {
			probeErr = err
			return
		}
		defer os.RemoveAll(dir)
		target := filepath.Join(dir, "target")
		if probeErr = os.Mkdir(target, 0o700); probeErr != nil {
			return
		}
		if probeErr = os.WriteFile(filepath.Join(target, "f"), []byte("x"), 0o600); probeErr != nil {
			return
		}
		link := filepath.Join(dir, "link")
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			probeErr = errors.New("mklink /J: " + err.Error() + ": " + string(out))
			return
		}
		_, err = os.ReadFile(filepath.Join(link, "f"))
		switch {
		case err == nil:
			probeOK = true
		case UntrustedMountPoint(err):
			probeOK = false
		default:
			probeErr = err
		}
	})
	if probeErr != nil {
		t.Fatalf("junction probe: %v", probeErr)
	}
	if err := refusedOnCI(os.Getenv("CI"), probeOK); err != nil {
		t.Fatal(err)
	}
	return probeOK
}

// refusedOnCI is the error for a CI run (CI set) on a Windows that refuses to traverse junctions: the runner is meant to exercise Coral's own junction layer, and with the
// system refusing first it no longer does, which a green run must not hide. Locally (CI empty) it is nil: the tests log which layer refused and assert that refusal.
func refusedOnCI(ci string, traversable bool) error {
	if ci != "" && !traversable {
		return errors.New("CI no longer exercises Coral's junction layer: this Windows refuses to traverse a junction (untrusted mount point), so the system refuses before safefs does")
	}
	return nil
}
