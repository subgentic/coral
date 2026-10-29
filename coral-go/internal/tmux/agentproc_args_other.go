//go:build !linux && !darwin

package tmux

// ProgramArgs: not read on this platform.
func ProgramArgs(pid int) []string { return nil }
