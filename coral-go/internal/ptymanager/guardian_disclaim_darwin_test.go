//go:build darwin

package ptymanager

import (
	"os"
	"testing"

	"github.com/ebitengine/purego"
)

func responsiblePid(t *testing.T, pid int) int {
	t.Helper()
	lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		t.Fatal(err)
	}
	var get func(pid int32) int32
	purego.RegisterLibFunc(&get, lib, "responsibility_get_pid_responsible_for_pid")
	return int(get(int32(pid)))
}

// #12836: the guardian, and so the terminals under it, is not attributed to Coral.app: a GUI program of Coral.app that exited made macOS force-quit everything attributed to it.
func TestTheGuardianIsNotAttributedToCoral(t *testing.T) {
	canFork(t)
	b := NewPTYBackend()
	t.Cleanup(func() { b.Close() })
	const id = "00000000-0000-4000-8000-000000012836"
	if err := b.Spawn("claude-"+id, "claude", t.TempDir(), id, "sleep 600", 80, 24); err != nil {
		t.Fatal(err)
	}
	pid, _ := guardian.pid()
	if pid <= 1 {
		t.Fatal("a guardian should be running")
	}
	if mine, got := responsiblePid(t, os.Getpid()), responsiblePid(t, pid); got == mine || got != pid {
		t.Fatalf("the guardian is attributed to process %d (Coral's own is %d), so macOS takes it down with Coral.app; want itself (%d)", got, mine, pid)
	}
}
