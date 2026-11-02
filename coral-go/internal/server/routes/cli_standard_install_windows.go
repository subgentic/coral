//go:build windows

package routes

import "os"

// standardFileOK is a regular file on Windows: it has no owner and mode bits in this form (the same reason nativeInstallerPlace is false there); the temp-folder and data-folder checks and CheckRunnable stay.
func standardFileOK(real string) bool {
	st, err := os.Stat(real)
	return err == nil && st.Mode().IsRegular()
}

// standardChainOK is true on Windows: folder owners and modes are not checked there (see standardFileOK).
func standardChainOK(string, string) bool { return true }
