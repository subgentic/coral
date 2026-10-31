//go:build windows

package routes

// nativeInstallerPlace is false on Windows: the exemption rests on file owners and modes, which Windows does not have in this form, so an agent working in the home folder still refuses a CLI under it.
func nativeInstallerPlace(string, map[string]bool) bool { return false }
