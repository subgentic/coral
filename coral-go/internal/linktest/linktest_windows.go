//go:build windows

package linktest

import (
	"os"
	"os/exec"
	"testing"

	"github.com/subgentic/coral/internal/executil"
)

func kinds() []string { return []string{"symlink", "junction", "hardlink"} }

func plant(t *testing.T, kind, path string) Planted {
	t.Helper()
	switch kind {
	case "symlink":
		return plantSymlink(t, path)
	case "hardlink":
		return plantHardLink(t, path)
	}
	target := path + ".junction-target"
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	mk := exec.Command("cmd", "/c", "mklink", "/J", path, target)
	executil.HideWindow(mk) // a console program from a test binary with no console opens a window (#383)
	if out, err := mk.CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v: %s", err, out)
	}
	return Planted{Kind: "junction", Target: target, Folder: true}
}
