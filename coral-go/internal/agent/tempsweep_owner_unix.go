//go:build !windows

package agent

import (
	"os"
	"syscall"
)

// ownedByCurrentUser reports whether info's file (already Lstat'd, so a link is not followed) belongs to this process's user.
func ownedByCurrentUser(_ string, info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// removeOwnedFile removes the file by its exact path (the caller checked it was a regular file of ours just before).
func removeOwnedFile(path string) error { return os.Remove(path) }
