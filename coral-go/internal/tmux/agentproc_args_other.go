//go:build !linux && !darwin

package tmux

// ProgramArgs: not read on this platform.
func ProgramArgs(pid int) []string { return nil }

// ProgramCwd: not read on this platform.
func ProgramCwd(pid int) string { return "" }
