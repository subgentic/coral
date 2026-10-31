//go:build unix

package testtemp

import (
	"os"
	"syscall"
)

// ownedByMe reports whether this user owns fi: /tmp is shared, and another user's folders are not this run's to remove.
func ownedByMe(_ string, fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// ownerOnly is a no-op on Unix: os.MkdirTemp makes the folder 0700 already.
func ownerOnly(string) (changed bool, err error) { return false, nil }

// ownerOnlyAcl reports whether dir is closed to group and others.
func ownerOnlyAcl(dir string) bool {
	fi, err := os.Stat(dir)
	return err == nil && fi.Mode().Perm()&0o077 == 0
}
