//go:build linux

package tmux

import (
	"fmt"
	"os"
)

// ProgramImage is the path of the program a process runs (the same user's only). "" when it cannot be read.
func ProgramImage(pid int) string {
	p, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return ""
	}
	return p
}
