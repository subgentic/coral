//go:build !windows

package ptymanager

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// A terminal whose process has ended can be asked to Terminate hours later (Kill All, then a Wake that replaces it), by which time the pid may belong to an unrelated process. Terminate must
// then signal nothing: the pid and its group are not the terminal's any more. The stand-in for the recycled pid is a live process of the test's own, in a group of its own (#14172, Security).
func TestTerminateOfAnEndedTerminalSignalsNothing(t *testing.T) {
	bystander := exec.Command("sleep", "30")
	bystander.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := bystander.Start(); err != nil {
		t.Skipf("cannot start a bystander: %v", err)
	}
	t.Cleanup(func() { _ = bystander.Process.Kill(); _, _ = bystander.Process.Wait() })

	ended := &unixPTY{cmd: &exec.Cmd{Process: bystander.Process}, done: make(chan struct{})}
	close(ended.done) // its own process has ended; the pid it remembers is now the bystander's

	_ = ended.Terminate()
	_ = ended.ForceKill()

	time.Sleep(300 * time.Millisecond) // sleep-ok: giving a wrongly sent signal time to land before asserting that none did
	if err := bystander.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("Terminate or ForceKill of an ended terminal signalled a process that is not its own: %v", err)
	}
	var st syscall.WaitStatus
	if pid, err := syscall.Wait4(bystander.Process.Pid, &st, syscall.WNOHANG, nil); err == nil && pid == bystander.Process.Pid {
		t.Fatalf("the bystander was ended by the ended terminal's signals (status %v)", st)
	}
	_ = os.Stdout
}
