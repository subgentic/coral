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

// standardChainOK: for every root but the three fixed system roots, the root and every folder below it down to dir are owned by the user (for a root under home) or by the user or root (outside it), and not writable by
// group or others: a folder on the way that others can write lets them replace the file even when the file looks fine (Security's #11467 and SHOULD on #12365). The fixed system roots (/usr/local, /opt/homebrew,
// linuxbrew) are not checked this way (Homebrew's are group-writable by design); their file is checked by standardFileOK.
func standardChainOK(root, dir string) bool {
	root, dir = filepath.Clean(realOrSelf(root)), filepath.Clean(realOrSelf(dir)) // both resolved: a root typed through a link and a folder resolved must meet
	if systemRoot(root) || systemRoot(filepath.Clean(root)) {
		return true
	}
	inHome := underHome(root)
	for d := dir; ; d = filepath.Dir(d) {
		st, err := os.Stat(d)
		if err != nil || !st.IsDir() || st.Mode().Perm()&0o022 != 0 {
			return false
		}
		if s, ok := st.Sys().(*syscall.Stat_t); !ok || !(int(s.Uid) == os.Getuid() || (!inHome && s.Uid == 0)) {
			return false
		}
		if d == root || d == filepath.Dir(d) {
			return true
		}
	}
}
