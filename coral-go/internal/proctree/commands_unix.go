//go:build !windows

package proctree

import (
	"context"
	"os"
	"os/exec"
	"time"
)

// CommandsBelow runs ps and answers the command lines below root; ok is false when that cannot be known.
func CommandsBelow(ctx context.Context, root int) (cmds []string, ok bool) {
	if root <= 1 {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, psPath(), "-axo", "pid=,ppid=,command=").Output()
	if err != nil {
		return nil, false
	}
	return Below(Parse(string(out)), root), true
}

// psPath is ps by its absolute path, not by the name on the server's PATH (Security's INFO, #13645).
func psPath() string {
	for _, p := range []string{"/bin/ps", "/usr/bin/ps"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "ps"
}
