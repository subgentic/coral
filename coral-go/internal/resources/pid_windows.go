//go:build windows

package resources

// processAlive: on Windows a hand claim is tied to its tool call alone (the shell's process is not looked at), so it goes back when the call ends.
func processAlive(pid int) bool { return false }
