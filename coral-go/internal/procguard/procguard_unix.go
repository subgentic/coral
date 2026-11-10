//go:build !windows

// Package procguard is the one place Coral sends a signal to a process it did not start itself in this call: a pid or a process group it recorded earlier (an agent's shell, a background job, a command group).
// A recorded pid or group that has gone stale, been reused or never been the agent's own (a terminal that did not get its own group) can name Coral, or the shell Coral was started from, and a SIGKILL to that
// ends the server with no word (#15011: 'zsh: killed coral'). Coral never signals its own pid, its own process group, its parent's pid or its parent's group, nor pid 0, 1 or -1 (everything): it logs and refuses.
package procguard

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"syscall"
)

// ErrSelf says a signal was refused because the target is Coral itself, its parent shell or a group that holds either, or all processes.
var ErrSelf = errors.New("refused: the target is Coral itself, its parent shell, or all processes")

// The seams: who Coral and its parent are, a variable so a test can stand in for them.
var (
	selfPid    = os.Getpid
	selfPgid   = func() int { return syscall.Getpgrp() }
	parentPid  = os.Getppid
	parentPgid = func() int {
		g, err := syscall.Getpgid(os.Getppid())
		if err != nil {
			return 0
		}
		return g
	}
)

// Refuse is why a signal to target (a pid, or -pgid for a group, as syscall.Kill takes it) must not be sent, and whether it must not.
func Refuse(target int) (string, bool) {
	switch {
	case target == 0 || target == -1 || target == 1:
		return "pid 0, 1 and -1 name the caller's own group, init and every process", true
	case target > 1:
		if target == selfPid() {
			return "the target is Coral's own pid", true
		}
		if target == parentPid() {
			return "the target is the shell Coral was started from", true
		}
		return "", false
	default: // a process group, -pgid
		g := -target
		if g == selfPgid() {
			return "the target is Coral's own process group", true
		}
		if pg := parentPgid(); pg > 1 && g == pg {
			return "the target is the process group of the shell Coral was started from", true
		}
		return "", false
	}
}

// Kill is syscall.Kill that refuses, and says so, when the target is Coral itself or its parent (Refuse).
func Kill(target int, sig syscall.Signal) error {
	if why, refuse := Refuse(target); refuse {
		slog.Error("[procguard] a signal to Coral itself or its parent shell was refused", "target", target, "signal", sig.String(), "why", why)
		return fmt.Errorf("%w: %s (%d)", ErrSelf, why, target)
	}
	return syscall.Kill(target, sig)
}
