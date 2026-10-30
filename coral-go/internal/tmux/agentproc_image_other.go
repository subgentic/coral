//go:build !linux && !darwin

package tmux

// ProgramImage: this platform's ptymanager reads the image itself (Windows) or cannot (others).
func ProgramImage(pid int) string { return "" }
