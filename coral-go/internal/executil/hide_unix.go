//go:build !windows

package executil

import (
	"context"
	"errors"
	"os"
	"os/exec"
)

// HideWindow sets platform-specific flags to prevent console windows from flashing.
// On Unix, this is a no-op.
func HideWindow(cmd *exec.Cmd) {
	// No-op on Unix — no console window to hide.
}

// Command is like exec.CommandContext but hides console windows on Windows.
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}

// Kill ends cmd's process. Off Windows a command's children are not left behind by a .cmd shim, so the process is all there is to end.
func Kill(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}
