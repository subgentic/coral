//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// heavyOwnGroup runs the command in its own process group and, when the run is stopped (its context ends), kills the whole group: the shell alone dying leaves what it started running beside the next agent's run.
func heavyOwnGroup(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Cancel = func() error { return syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
}

// heavyUnsupportedHere: the heavy pool is the Mac and the mini, and a run can be stopped here (its command's whole process group is killed), so nothing is refused.
func heavyUnsupportedHere() string { return "" }
