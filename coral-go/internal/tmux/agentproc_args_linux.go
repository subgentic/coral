//go:build linux

package tmux

import (
	"fmt"
	"os"
	"strings"
)

// ProgramArgs is a process's argument vector, exactly (/proc/<pid>/cmdline is NUL-separated), for one comparison and then dropped: it is never logged or kept. nil when it cannot be read or is
// longer than the buffer. The program ITSELF is decided from ProgramImage; this only says where the script argument is.
func ProgramArgs(pid int) []string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil || len(b) == 0 || len(b) > 64*1024 {
		return nil
	}
	return strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
}

// ProgramCwd is a process's working directory (/proc/<pid>/cwd), "" when it cannot be read.
func ProgramCwd(pid int) string {
	d, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
	if err != nil {
		return ""
	}
	return d
}
