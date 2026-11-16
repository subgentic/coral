//go:build windows

package main

import (
	"os/exec"

	"github.com/subgentic/coral/internal/winjob"
)

// heavyOwnGroup: Windows has no process group, so the command runs in a Job Object with kill-on-close, a memory cap and a process cap (#17603). The returned function is called right after the
// start and puts the command in the job; stopping the run ends the whole job, and so does this process dying (a dropped connection).
func heavyOwnGroup(c *exec.Cmd) (afterStart func() error, closeJob func()) {
	j, err := winjob.New(winjob.Default)
	if err != nil {
		return func() error { return err }, func() {}
	}
	c.Cancel = func() error { return j.Kill() }
	return func() error { return j.Assign(c) }, func() { _ = j.Close() }
}

// heavyUnsupportedHere: a run can be stopped here (its Job Object ends whole), so nothing is refused.
func heavyUnsupportedHere() string { return "" }

// heavyShell: the checkout's commands are written for sh, which Git for Windows provides; found on the PATH, else its usual place.
func heavyShell() string {
	if p, err := exec.LookPath("sh.exe"); err == nil {
		return p
	}
	return `C:\Program Files\Git\bin\sh.exe`
}
