//go:build windows

package executil

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// HideWindow sets platform-specific flags to prevent console windows from flashing.
// On Windows, this sets CREATE_NO_WINDOW to suppress the console.
func HideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
	endTreeOnCancel(cmd)
}

// endTreeOnCancel makes a timed run (a command made with a context) end the whole tree when the context ends, not only the process Go started: a .cmd shim runs as cmd.exe /c and its
// real program is cmd.exe's child, which kept running after a timeout and kept Output waiting on its pipe (#349). A command that ends by itself is untouched. Every timed run
// that hides its window goes through here, so the CLI probes, git, gh and the sign-in checks all end the same way.
func endTreeOnCancel(cmd *exec.Cmd) {
	end := cmd.Cancel
	if end == nil {
		return // not made with a context: nothing ends it
	}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return end()
		}
		pid := uint32(cmd.Process.Pid)
		killTree(pid)
		if err := end(); err != nil && exited(pid) {
			return os.ErrProcessDone
		} else {
			return err
		}
	}
}

// Command is like exec.CommandContext but hides console windows on Windows.
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	HideWindow(cmd)
	return cmd
}

// Kill ends cmd's process and everything it started (a .cmd shim's real program is its child), for a command Coral stops itself once it has the answer it wanted (#349).
func Kill(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	pid := uint32(cmd.Process.Pid)
	killTree(pid)
	if err := killRoot(cmd.Process, pid); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}
