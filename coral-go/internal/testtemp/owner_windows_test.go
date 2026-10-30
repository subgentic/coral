package testtemp

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

// A private folder made under a folder whose list grants Users gets a list for this user alone, and what is made in it inherits that. A
// folder that is already this user's is left as it is.
func TestAPrivateFolderUnderAWiderFolderIsMadeThisUsersAlone(t *testing.T) {
	me, err := currentUser()
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("icacls", parent, "/inheritance:r", "/grant:r", "*"+me.String()+":(OI)(CI)F", "/grant:r", "*S-1-5-32-545:(OI)(CI)RX")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("icacls: %v: %s", err, out)
	}
	dir, err := os.MkdirTemp(parent, "ct-")
	if err != nil {
		t.Fatal(err)
	}
	if wider, err := widerThanOwner(dir, me); err != nil || !wider {
		t.Fatalf("the setup: the new folder inherits Users (wider %v, err %v)", wider, err)
	}

	changed, err := ownerOnly(dir)
	if err != nil || !changed {
		t.Fatalf("ownerOnly = %v, %v; want changed", changed, err)
	}
	if wider, err := widerThanOwner(dir, me); err != nil || wider {
		t.Errorf("after ownerOnly the folder still grants others (wider %v, err %v)", wider, err)
	}
	sub := filepath.Join(dir, "tmp")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	if wider, err := widerThanOwner(sub, me); err != nil || wider {
		t.Errorf("a folder made inside does not inherit the list (wider %v, err %v)", wider, err)
	}
	if changed, err := ownerOnly(dir); err != nil || changed {
		t.Errorf("a folder that is this user's alone was changed again (%v, %v)", changed, err)
	}
}
