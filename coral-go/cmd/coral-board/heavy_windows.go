//go:build windows

package main

import (
	"os"
	"os/exec"

	"github.com/subgentic/coral/internal/winjob"
)

// newJob makes the job; a variable so a test can make it fail.
var newJob = winjob.New

// heavyOwnGroup: Windows has no process group, so the command runs in a Job Object with kill-on-close, a memory cap and a process cap (#17603). The command starts suspended, and the returned function, called right
// after the start, puts it in the job and only then lets it run, so a child it forks in its first milliseconds is in the job too (#17721). Stopping the run ends the whole job, and so does this process dying (a dropped connection).
// If the job cannot be made or joined the function says so, the caller kills the command, and it has run nothing.
func heavyOwnGroup(c *exec.Cmd) (afterStart func() error, closeJob func()) {
	winjob.Suspended(c) // before anything else: with no job either, the command is started and killed without having run
	j, err := newJob(winjob.Default)
	if err != nil {
		return func() error { return err }, func() {}
	}
	c.Cancel = func() error { return j.Kill() }
	return func() error {
		if err := j.Assign(c); err != nil {
			return err
		}
		return winjob.Resume(c)
	}, func() { _ = j.Close() }
}

// heavyUnsupportedHere: a run can be stopped here (its Job Object ends whole), so only a missing shell refuses: sh.exe neither on the PATH nor at Git for Windows' usual place is said so, not left to a
// "file not found" from the start (#17721).
func heavyUnsupportedHere() string {
	if _, err := os.Stat(heavyShell()); err != nil {
		return `heavy run needs sh.exe (from Git for Windows) and found it neither on the PATH nor at C:\Program Files\Git\bin\sh.exe: install Git for Windows, or put its bin folder on the PATH`
	}
	return ""
}

// heavyShell: the checkout's commands are written for sh, which Git for Windows provides; found on the PATH, else its usual place.
func heavyShell() string {
	if p, err := exec.LookPath("sh.exe"); err == nil {
		return p
	}
	return `C:\Program Files\Git\bin\sh.exe`
}
