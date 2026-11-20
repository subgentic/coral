package healthcheck

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// maxScript is the largest script Coral will snapshot.
const maxScript = 1 << 20

// Snapshot copies the script at src to dir/<sha256> (the folder owner-only, the copy read-only) and returns the hash and the copy's path. Coral runs only the copy: an edit of the original changes
// nothing until the Operator approves a new snapshot. A leaf that is a symlink or a hard link, or not a plain file, is refused.
func Snapshot(src, dir string) (hash, path string, err error) {
	fi, err := os.Lstat(src)
	if err != nil {
		return "", "", err
	}
	switch {
	case fi.Mode()&os.ModeSymlink != 0:
		return "", "", errors.New("the script is a symbolic link: give its real file")
	case !fi.Mode().IsRegular():
		return "", "", errors.New("the script is not a plain file")
	case linkCount(fi) > 1:
		return "", "", errors.New("the script is a hard link: copy it to its own file")
	case fi.Size() > maxScript:
		return "", "", fmt.Errorf("the script is over %d bytes", maxScript)
	}
	f, err := os.Open(src)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxScript+1))
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256(b)
	hash = hex.EncodeToString(sum[:])
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	path = filepath.Join(dir, hash)
	if h, herr := HashFile(path); herr == nil && h == hash {
		return hash, path, nil
	}
	tmp, err := os.CreateTemp(dir, ".snap-*")
	if err != nil {
		return "", "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return "", "", err
	}
	if err := tmp.Close(); err != nil {
		return "", "", err
	}
	if err := os.Chmod(tmp.Name(), 0o500); err != nil {
		return "", "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", "", err
	}
	return hash, path, nil
}

// HashFile is the SHA-256 of the file at path: a run checks its snapshot still has the approved hash before it starts.
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, maxScript+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
