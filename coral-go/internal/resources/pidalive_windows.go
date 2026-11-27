//go:build windows

package resources

// processAlive: not looked up on Windows (#21800); every run counts as alive, so the slot frees as before.
func processAlive(pid int) bool { return true }
