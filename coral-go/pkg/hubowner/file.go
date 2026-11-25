package hubowner

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/secfile"
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
	return writePrivate(dir, FileName, remoteID+"\n"+secret+"\n")
}

// writePrivate writes content to dir/name: mode 0600, a new temporary file renamed over it, never through a link.
func writePrivate(dir, name, content string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	final := filepath.Join(dir, name)
	if fi, err := os.Lstat(final); err == nil && !fi.Mode().IsRegular() {
		return fmt.Errorf("hubowner: %s is not a plain file", name)
	}
	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return err
	}
	tmpName := filepath.Join(dir, name+".tmp-"+hex.EncodeToString(rnd[:]))
	// created new, never through a link, and on Windows with a private access list from the first byte (secfile.OpenNoFollow protects the handle)
	tmp, err := secfile.OpenNoFollow(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(tmpName)
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return fsreplace.Rename(tmpName, final)
}

// ReadFile reads what WriteFile wrote: a regular file (never a link), at most 512 bytes, and on a system with mode bits private to its user. ok is false, with no error, when there is none.
func ReadFile(dir string) (remoteID, secret string, ok bool, err error) {
	b, ok, err := readPrivate(dir, FileName, maxFile)
	if err != nil || !ok {
		return "", "", false, err
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) != 2 || !ValidRemoteID(lines[0]) || !ValidSecret(lines[1]) {
		return "", "", false, fmt.Errorf("hubowner: %s is not an id and a secret", FileName)
	}
	return lines[0], lines[1], true, nil
}

// Installed reports whether a valid secret of any hub is in dir: what the remote's /api/health says about itself.
func Installed(dir string) bool {
	ls, err := Links(dir)
	return err == nil && len(ls) > 0
}

// InstalledAt is when a hub's secret was last installed, replaced or removed here (the newer modification time of the two files) and whether a valid one is there: what the remote's health answer and its
// log say about a secret that was installed or replaced, so a silent rotation shows.
func InstalledAt(dir string) (time.Time, bool) {
	if !Installed(dir) {
		return time.Time{}, false
	}
	var at time.Time
	for _, name := range []string{FileName, LinksFileName} {
		if fi, err := os.Lstat(filepath.Join(dir, name)); err == nil && fi.ModTime().After(at) {
			at = fi.ModTime()
		}
	}
	return at.UTC().Truncate(time.Second), true
}

// readPrivate reads dir/name as writePrivate leaves it: a regular file (never a link), at most limit bytes, and on a system with mode bits private to its user. ok is false, with no error, when there is
// none.
func readPrivate(dir, name string, limit int64) ([]byte, bool, error) {
	path := filepath.Join(dir, name)
	fi, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > limit {
		return nil, false, fmt.Errorf("hubowner: %s is not a plain small file", name)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
		return nil, false, fmt.Errorf("hubowner: %s is readable by others: fix its mode to 0600", name)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !os.SameFile(fi, st) {
		return nil, false, fmt.Errorf("hubowner: %s changed while it was opened", name)
	}
	if err := secfile.CheckOpen(f); err != nil { // Windows: one name, this user's, an access list no other account can write (made private if inherited); nothing outside Windows
		return nil, false, err
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, false, fmt.Errorf("hubowner: %s could not be read as a small file", name)
	}
	return b, true, nil
}
