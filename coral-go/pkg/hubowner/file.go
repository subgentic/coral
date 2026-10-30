package hubowner

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// FileName is the file in the remote's data folder that holds the id the hub knows it by and the stamp secret. Only a human act writes it: the hub's SSH session (`coral hub-owner-secret` on the remote, the
// secret on stdin) or the remote's own command line. No HTTP route, whatever key it is called with, can create or change it.
const FileName = "hub_owner_secret"

const maxFile = 512

// WriteFile installs the id and the secret in dir (mode 0600, written to a temporary file and renamed, never through a link). It replaces an earlier file: rotating the secret is a human act too.
func WriteFile(dir, remoteID, secret string) error {
	if !ValidRemoteID(remoteID) || !ValidSecret(secret) {
		return errors.New("hubowner: not a valid remote id and secret")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	final := filepath.Join(dir, FileName)
	if fi, err := os.Lstat(final); err == nil && !fi.Mode().IsRegular() {
		return fmt.Errorf("hubowner: %s is not a plain file", FileName)
	}
	tmp, err := os.CreateTemp(dir, FileName+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(remoteID + "\n" + secret + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, final)
}

// ReadFile reads what WriteFile wrote: a regular file (never a link), at most 512 bytes, and on a system with mode bits private to its user. ok is false, with no error, when there is none.
func ReadFile(dir string) (remoteID, secret string, ok bool, err error) {
	path := filepath.Join(dir, FileName)
	fi, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > maxFile {
		return "", "", false, fmt.Errorf("hubowner: %s is not a plain small file", FileName)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
		return "", "", false, fmt.Errorf("hubowner: %s is readable by others: fix its mode to 0600", FileName)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", "", false, err
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) != 2 || !ValidRemoteID(lines[0]) || !ValidSecret(lines[1]) {
		return "", "", false, fmt.Errorf("hubowner: %s is not an id and a secret", FileName)
	}
	return lines[0], lines[1], true, nil
}

// Installed reports whether a valid file is in dir: what the remote's /api/health says about itself.
func Installed(dir string) bool {
	_, _, ok, err := ReadFile(dir)
	return ok && err == nil
}
