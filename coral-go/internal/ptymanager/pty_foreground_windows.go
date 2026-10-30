//go:build windows

package ptymanager

import (
	"fmt"
	"path/filepath"
	"strings"
)

// ShellIdle reports whether the process the terminal started is a shell (powershell, pwsh, cmd) with no program running under it,
// only shells if anything: the agent CLI typed into it has exited and left a bare prompt, which would run automated text as a
// command (#3219, #378). A shell a person started at that prompt (cmd typed into PowerShell) is a bare prompt too: cmd runs
// anything after an '&' (#378, seen live). ConPTY names no
// shell pid for the Unix check (tmux.ShellIdle reads ps), so this is its own: the root's image through its handle and a snapshot of
// the process list, the checks the polite stop makes (#5665). A root that is not a shell is the agent itself, started directly, so
// not idle. Windows has no foreground job, so any program under it (the agent, or a job the person left running) counts as busy.
// err is set when it can't tell.
func (p *windowsPTY) ShellIdle() (idle bool, shell string, err error) {
	pid := p.cpty.Pid()
	if pid <= 0 {
		return false, "", fmt.Errorf("no shell pid")
	}
	image, ok := processImage(pid)
	if !ok {
		return false, "", fmt.Errorf("read process %d", pid)
	}
	shell = strings.TrimSuffix(strings.ToLower(filepath.Base(image)), ".exe")
	if !isShellImage(image) {
		return false, shell, nil
	}
	busy, err := runsNonShell(pid)
	if err != nil {
		return false, shell, err
	}
	return !busy, shell, nil
}
