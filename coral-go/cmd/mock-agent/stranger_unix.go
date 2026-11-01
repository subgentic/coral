//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

// strangerAttr starts the stranger as a shell starts a job: in a process group of its own that becomes the terminal's foreground group, so the agent is no longer the program in front.
func strangerAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Foreground: true, Ctty: 0}
}

// reclaimTerminal makes the mock's own group the terminal's foreground group again once the stranger has ended (SIGTTOU ignored meanwhile: a background group may not set it otherwise).
func reclaimTerminal() {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return
	}
	signal.Ignore(syscall.SIGTTOU)
	defer signal.Reset(syscall.SIGTTOU)
	_ = unix.IoctlSetPointerInt(fd, unix.TIOCSPGRP, syscall.Getpgrp())
}
