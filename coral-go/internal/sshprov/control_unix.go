//go:build !windows

package sshprov

import (
	"errors"
	"os"
	"syscall"
)

// ensurePrivateDir makes dir (0700) if it is not there and refuses it unless it is a real folder, not a link, owned by this user and with no access for anyone else: a socket in it is then the hub user's alone.
func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("sshprov: the control folder is not a folder")
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || int(sys.Uid) != os.Getuid() {
		return errors.New("sshprov: the control folder is not this user's")
	}
	if st.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
		if st, err = os.Lstat(dir); err != nil || st.Mode().Perm()&0o077 != 0 {
			return errors.New("sshprov: the control folder is open to others")
		}
	}
	return nil
}
