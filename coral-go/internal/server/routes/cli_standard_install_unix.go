//go:build !windows

package routes

import (
	"os"
	"path/filepath"
	"syscall"
)

// standardFileOK: a regular file owned by the current user or by root, not writable by group or others.
func standardFileOK(real string) bool {
	st, err := os.Stat(real)
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0o022 != 0 {
		return false
	}
	s, ok := st.Sys().(*syscall.Stat_t)
	return ok && (int(s.Uid) == os.Getuid() || s.Uid == 0)
}

// standardChainOK: for a root under the home folder, the root and every folder below it down to dir are the user's and not writable by group or others. A system root (/usr/local, /opt/homebrew) is not checked this way
// (Homebrew's are group-writable by design); its file is checked by standardFileOK.
func standardChainOK(root, dir string) bool {
	root, dir = filepath.Clean(realOrSelf(root)), filepath.Clean(realOrSelf(dir)) // both resolved: a root typed through a link and a folder resolved must meet
	if !underHome(root) {
		return true
	}
	for d := dir; ; d = filepath.Dir(d) {
		if !privateDir(d) {
			return false
		}
		if d == root || d == filepath.Dir(d) {
			return true
		}
	}
}
