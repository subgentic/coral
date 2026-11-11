package push

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/updater/verify"
)

var plainVersion = regexp.MustCompile(`^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$`)

// PlainVersion is a release version with no prerelease part: the only kind a push offers (what a computer would offer as Latest).
func PlainVersion(v string) bool { return plainVersion.MatchString(v) }

// Receive reads a stream from r into root/<version> (root is <data>/updates/staging). It writes into a fixed ".<version>.partial" folder (0700, files
// 0600, each created new), and renames it into place only when the whole stream was well formed and the package's SHA-256 is the record's. That
// last comparison only guards against a damaged transfer, because the record travels in the same stream: the real check is the apply's own verification.
// Nothing outside root is touched. Every other entry of root is removed once the new one is in place, as a staging step does.
func Receive(r io.Reader, root, version, asset string, maxPackage int64) error {
	if !PlainVersion(version) {
		return errors.New("push: the version is not X.Y.Z")
	}
	if err := verify.EnsureDir(root); err != nil {
		return err
	}
	partial := filepath.Join(root, "."+version+".partial")
	if fi, err := os.Lstat(partial); err == nil {
		if !fi.IsDir() {
			return errors.New("push: the partial folder is not a folder; it was not removed")
		}
		if err := os.RemoveAll(partial); err != nil {
			return err
		}
	}
	if err := os.Mkdir(partial, 0o700); err != nil {
		return err
	}
	done := false
	defer func() {
		if !done {
			os.RemoveAll(partial)
		}
	}()
	rd := NewReader(r, asset, maxPackage)
	pkgSum := ""
	for {
		name, body, err := rd.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		f, err := os.OpenFile(filepath.Join(partial, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, verify.PrivateMode)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, cerr := io.Copy(io.MultiWriter(f, h), body)
		if cerr == nil {
			cerr = f.Sync()
		}
		if clerr := f.Close(); cerr == nil {
			cerr = clerr
		}
		if cerr != nil {
			return cerr
		}
		if lr, ok := body.(*io.LimitedReader); ok && lr.N != 0 {
			return errors.New("push: a file ended early")
		}
		if name == asset {
			pkgSum = hex.EncodeToString(h.Sum(nil))
		}
	}
	recBytes, err := os.ReadFile(filepath.Join(partial, "record.json"))
	if err != nil {
		return err
	}
	var rec verify.Record
	if err := json.Unmarshal(recBytes, &rec); err != nil {
		return errors.New("push: the record is not readable")
	}
	if rec.Version != version || rec.Asset != asset {
		return errors.New("push: the record is for another version or package")
	}
	if rec.PackageSHA256 != pkgSum {
		return fmt.Errorf("push: the package was damaged in transfer")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() != filepath.Base(partial) {
			if err := os.RemoveAll(filepath.Join(root, e.Name())); err != nil {
				return err
			}
		}
	}
	if err := fsreplace.Rename(partial, filepath.Join(root, version)); err != nil {
		return err
	}
	done = true
	return nil
}
