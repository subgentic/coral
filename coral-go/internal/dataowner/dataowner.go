// Package dataowner ties sessions.db to the data folder that made it (task #429, after the duplicate-resume incident of 2026-11-01).
//
// A copy of a live sessions.db is not inert: on startup Coral resumes the sessions the database lists, and on a shared tmux server it could type into the REAL agents' panes. So a Coral
// that cannot show that the database is this folder's own (a FOREIGN Coral) wakes, recovers and types nothing. The tie is a random 128-bit id kept in two places that must agree: a row in
// sessions.db and the file <data dir>/data_dir_id. A database copied alone has the row and no file. It is a safety rail, not a security boundary: whoever can copy both can forge it.
//
// Verify decides once per start, before anything acts on live_sessions:
//   - file and row present and equal: OWNED (a folder moved or restored: the path in the file no longer exists, so it is rewritten). If the path in the file is ANOTHER folder that still exists and
//     holds the same id, this is a whole-folder copy made next to the live one: FOREIGN;
//   - file and row present and different, or only one of them: FOREIGN;
//   - neither: the id is made, OWNED. That is a first start, and an install from before the id existed upgrading in place (#12591: v2.0.37 judged the operator's real folder, which predates the id, by how
//     old its files looked, got it wrong, and left every agent without delivery). Nothing here tells such a folder from a copy of one: a copy of a database that already carries the row is the case the
//     id is for, and it has the row.
//
// Anything that cannot be read or written is FOREIGN. FOREIGN never stops Coral from starting; it only withholds what acts on the agents.
package dataowner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

// FileName is the id file in the data folder.
const FileName = "data_dir_id"

// maxFile caps how much of the id file is read.
const maxFile = 256

// Reasons a Coral is FOREIGN: fixed strings (they go to the log, the notice and the status as they are, never built from file content).
const (
	ReasonRowOnly    = "the database carries an id but this folder has no id file"
	ReasonFileOnly   = "this folder has an id file but the database carries none"
	ReasonDiffer     = "the database and this folder carry different ids"
	ReasonCopy       = "another folder with the same id still exists"
	ReasonUnreadable = "the id could not be read or written"
	ReasonNotLocal   = "the id file names a path that is not a local folder"
)

// Notice is the one dashboard warning and log sentence when the ids show this may be a copy. It is a fixed string. Coral runs as usual: nothing waits on the person's answer (#12591).
const Notice = "This database carries an id that does not match this data folder, so it may be a copy of another Coral's. Coral is running as usual. " +
	"If this is your data folder (a restore, or an id file you deleted), press This is my data folder."

// Probe is what Verify reads and writes. Every field is required.
type Probe struct {
	Dir       string                                // the data folder
	Marker    func(context.Context) (string, error) // the id in the database; "" when there is none
	SetMarker func(context.Context, string) error   // store the id in the database
}

// Verdict is the result of Verify.
type Verdict struct {
	Foreign bool
	Reason  string // one of the Reason constants when Foreign
	Detail  string // a cleaned, capped path for the log line ("a folder with the same id exists at ..."); never trusted text
	Made    bool   // the id was made or rewritten by this call
}

// Verify decides whether the database is this folder's own, making the id when the rules above allow.
func Verify(ctx context.Context, p Probe) Verdict {
	fileID, fileAt, fileErr := readFile(p.Dir)
	rowID, rowErr := p.Marker(ctx)
	if (fileErr != nil && !errors.Is(fileErr, fs.ErrNotExist)) || rowErr != nil {
		return Verdict{Foreign: true, Reason: ReasonUnreadable}
	}
	haveFile, haveRow := fileErr == nil, rowID != ""
	switch {
	case haveFile && haveRow && fileID == rowID:
		if fileAt != "" && !sameText(fileAt, p.Dir) {
			// the path comes from the folder: one that is not a local absolute path is not read at all (no stat, no link resolution), and is "cannot tell", which is the safe side
			if !isLocalAbsolute(fileAt) {
				return Verdict{Foreign: true, Reason: ReasonNotLocal, Detail: clean(fileAt)}
			}
			if !sameFolder(fileAt, p.Dir) {
				if exists, carries := otherFolderHoldsID(fileAt, fileID); exists && carries {
					return Verdict{Foreign: true, Reason: ReasonCopy, Detail: clean(fileAt)}
				}
				// the old folder is gone: a move or a restore. Rewrite the path.
				if err := writeFile(p.Dir, fileID); err != nil {
					return Verdict{Foreign: true, Reason: ReasonUnreadable}
				}
				return Verdict{Made: true}
			}
		}
		return Verdict{}
	case haveFile && haveRow:
		return Verdict{Foreign: true, Reason: ReasonDiffer}
	case haveRow:
		return Verdict{Foreign: true, Reason: ReasonRowOnly}
	case haveFile:
		return Verdict{Foreign: true, Reason: ReasonFileOnly}
	}
	// neither: a first start, or an install from before the id upgrading in place: the id is made and the folder is its own
	if err := Adopt(ctx, p); err != nil {
		return Verdict{Foreign: true, Reason: ReasonUnreadable}
	}
	return Verdict{Made: true}
}

// Adopt makes a new id and stores it in the database and in the folder: the database is then this folder's own at the next start. The operator's action (coral --adopt-data-dir, with Coral stopped).
// It wakes nothing.
func Adopt(ctx context.Context, p Probe) error {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	id := hex.EncodeToString(b)
	if err := writeFile(p.Dir, id); err != nil {
		return err
	}
	return p.SetMarker(ctx, id)
}

// The file-system calls this package makes on a path: variables so that a test can prove which paths are touched.
var (
	statPath  = os.Stat
	lstatPath = os.Lstat
	evalLinks = filepath.EvalSymlinks
)

// isLocalAbsolute reports whether p is an absolute path on a local drive (or, off Windows, an absolute path): not a UNC or device path (two leading separators, which covers the extended and device
// prefixes), not a scheme, not a drive-relative or rooted-without-drive path, not an alternate stream, no control characters. Nothing is looked up on disk to decide.
func isLocalAbsolute(p string) bool {
	if p == "" {
		return false
	}
	for _, r := range p {
		if unicode.IsControl(r) {
			return false
		}
	}
	sep := func(b byte) bool { return b == '/' || b == 0x5c }
	if len(p) >= 2 && sep(p[0]) && sep(p[1]) {
		return false
	}
	if runtime.GOOS == "windows" {
		letter := len(p) >= 1 && (p[0] >= 'a' && p[0] <= 'z' || p[0] >= 'A' && p[0] <= 'Z')
		if len(p) < 3 || !letter || p[1] != ':' || !sep(p[2]) {
			return false
		}
		return !strings.Contains(p[2:], ":")
	}
	return p[0] == '/' && !strings.Contains(p, "://")
}

// sameText compares two paths as text only (cleaned, and case-folded on Windows): no file-system call. The folder Coral started with is compared this way first, so a data folder that is itself
// given as a network path still recognises its own id file.
func sameText(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if abs, err := filepath.Abs(b); err == nil {
		b = abs
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// readFile reads the id file: at most maxFile bytes, 32 hex digits on the first line and an optional "made at <path>" second line. A malformed file is an error (FOREIGN).
func readFile(dir string) (id, madeAt string, err error) {
	path := filepath.Join(dir, FileName)
	if fi, err := lstatPath(path); err != nil { // a link is refused, as the writer does not follow one (a not-exist error stays one: no file)
		return "", "", err
	} else if !fi.Mode().IsRegular() {
		return "", "", fmt.Errorf("the id file is not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return "", "", fmt.Errorf("the id file is not a regular file")
	}
	b, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return "", "", err
	}
	if len(b) > maxFile {
		return "", "", fmt.Errorf("the id file is too long")
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	id = strings.TrimSpace(lines[0])
	if !validID(id) {
		return "", "", fmt.Errorf("the id file does not hold an id")
	}
	for _, l := range lines[1:] {
		if rest, ok := strings.CutPrefix(l, "made at "); ok {
			madeAt = strings.TrimSpace(rest)
			break
		}
	}
	return id, madeAt, nil
}

func validID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// writeFile writes the id file, owner-only and created exclusively (an existing file is removed first).
func writeFile(dir, id string) error {
	path := filepath.Join(dir, FileName)
	if _, err := os.Lstat(path); err == nil {
		if err := os.Remove(path); err != nil { // a replaced file is removed first, never written through a link
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	abs, aerr := filepath.Abs(dir)
	if aerr != nil {
		abs = dir
	}
	_, werr := fmt.Fprintf(f, "%s\nmade at %s\n", id, abs)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// otherFolderHoldsID reports whether the folder path exists (an error reading it other than "does not exist" counts as existing, the safe side) and whether it holds an id file with the same id.
func otherFolderHoldsID(path, id string) (exists, carries bool) {
	if _, err := statPath(path); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, false
		}
		return true, true // cannot tell: the safe side is a copy
	}
	other, _, err := readFile(path)
	return true, err == nil && other == id
}

// sameFolder compares two folders with links resolved and, on Windows, case folded. A path that cannot be resolved is compared as given.
func sameFolder(a, b string) bool {
	norm := func(p string) string {
		if r, err := evalLinks(p); err == nil {
			p = r
		}
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		p = filepath.Clean(p)
		if runtime.GOOS == "windows" {
			p = strings.ToLower(p)
		}
		return p
	}
	return norm(a) == norm(b)
}

// clean makes text from a file safe for a log line or a notice: control and format characters dropped, and a text over 120 characters cut in the middle (the first 50 and the last 67, with "..."
// between): what names a folder is the end of its path, and a long temporary or home path used to lose it to a cut at the head (#277 on macOS, where a test's temporary path alone is over 120).
func clean(s string) string {
	var kept []rune
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		kept = append(kept, r)
	}
	if len(kept) <= 120 {
		return string(kept)
	}
	return string(kept[:50]) + "..." + string(kept[len(kept)-67:])
}

// LogLine is the one log line of a FOREIGN start.
func LogLine(v Verdict) string {
	line := "[data-dir] WARNING: " + Notice + " Why: " + v.Reason + "."
	if v.Detail != "" && v.Reason == ReasonNotLocal {
		line += " The path in the id file is " + v.Detail + "."
	} else if v.Detail != "" {
		line += " A folder with the same id exists at " + v.Detail + "."
	}
	return line
}
