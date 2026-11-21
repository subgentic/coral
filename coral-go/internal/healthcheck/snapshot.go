package healthcheck

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/fsreplace"
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
	if ofi, serr := f.Stat(); serr != nil || !os.SameFile(fi, ofi) {
		return "", "", errors.New("the script changed while it was being read")
	}
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
	if err := fsreplace.Rename(tmp.Name(), path); err != nil {
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

var hashRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// SnapshotPath is where the snapshot of the script with this hash is, inside dir: derived from the hash, never from a stored path, so a row cannot make Coral run a file that is not in its own folder.
// ok is false for a hash that is not 64 hex digits or an empty dir.
func SnapshotPath(dir, hash string) (string, bool) {
	if dir == "" || !hashRE.MatchString(hash) {
		return "", false
	}
	return filepath.Join(dir, hash), true
}

// maxShown is how much of a script is shown to the Operator.
const maxShown = 16 << 10

// ShownText reads the snapshot with this hash for the Operator to read beside the hash: only if the file still has that hash, cut at 16 KB, with every control, bidirectional and format
// character and every invalid byte written as an escape (\u{202e}, \x{ff}), so what is shown is what is there. Newlines and tabs stay. ok is false if there is no such snapshot.
func ShownText(dir, hash string) (text string, ok bool) {
	path, ok := SnapshotPath(dir, hash)
	if !ok {
		return "", false
	}
	if got, err := HashFile(path); err != nil || got != hash {
		return "", false
	}
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxShown+1))
	if err != nil {
		return "", false
	}
	cut := len(b) > maxShown
	if cut {
		b = b[:maxShown]
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		switch {
		case r == utf8.RuneError && n == 1:
			fmt.Fprintf(&sb, `\x{%02x}`, b[0])
		case r == '\n' || r == '\t':
			sb.WriteRune(r)
		case r == '\\':
			sb.WriteString(`\\`)
		case unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r):
			fmt.Fprintf(&sb, `\u{%x}`, r)
		default:
			sb.WriteRune(r)
		}
		b = b[n:]
	}
	if cut {
		sb.WriteString("\n... (cut: the script is longer)")
	}
	return sb.String(), true
}

// Prune removes every snapshot in dir whose hash is not in use: only a file named as a SHA-256 is ever touched, and a leaf that is not a plain file is left alone.
func Prune(dir string, inUse map[string]bool) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !hashRE.MatchString(e.Name()) || inUse[e.Name()] || !e.Type().IsRegular() {
			continue
		}
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
}
