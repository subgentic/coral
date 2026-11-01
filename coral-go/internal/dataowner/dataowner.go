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
//   - neither: a first start (no live sessions in the database): the id is made, OWNED. A database with live sessions and no id is an old install upgrading in place only if the folder is lived
//     in (messageboard.db has messages, api_key is older than a minute, and there is more in the folder than the databases and tokens): then the id is made, OWNED. Otherwise FOREIGN.
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
	"time"
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
	ReasonBare       = "the database lists agents but this folder is not an established Coral folder"
	ReasonUnreadable = "the id could not be read or written"
)

// Notice is the one dashboard notice and log sentence of a FOREIGN start. It is a fixed string.
const Notice = "This database was not made in this data folder, so no agent is woken or recovered at startup and Coral types nothing into any agent terminal by itself. " +
	"If you deleted the id file by accident, or this is a restore you want to keep, stop Coral and run: coral --adopt-data-dir. Agents can still be woken by hand from the list."

// Probe is what Verify reads and writes. Every field is required.
type Probe struct {
	Dir              string                                // the data folder
	Marker           func(context.Context) (string, error) // the id in the database; "" when there is none
	SetMarker        func(context.Context, string) error   // store the id in the database
	LiveSessions     func(context.Context) (int, error)    // how many live sessions the database lists
	BoardHasMessages func(context.Context) (bool, error)   // whether messageboard.db has any message
	Now              func() time.Time                      // the clock (time.Now when nil)
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
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	fileID, fileAt, fileErr := readFile(p.Dir)
	rowID, rowErr := p.Marker(ctx)
	if (fileErr != nil && !errors.Is(fileErr, fs.ErrNotExist)) || rowErr != nil {
		return Verdict{Foreign: true, Reason: ReasonUnreadable}
	}
	haveFile, haveRow := fileErr == nil, rowID != ""
	switch {
	case haveFile && haveRow && fileID == rowID:
		if fileAt != "" && !sameFolder(fileAt, p.Dir) {
			if exists, carries := otherFolderHoldsID(fileAt, fileID); exists && carries {
				return Verdict{Foreign: true, Reason: ReasonCopy, Detail: clean(fileAt)}
			}
			// the old folder is gone: a move or a restore. Rewrite the path.
			if err := writeFile(p.Dir, fileID); err != nil {
				return Verdict{Foreign: true, Reason: ReasonUnreadable}
			}
			return Verdict{Made: true}
		}
		return Verdict{}
	case haveFile && haveRow:
		return Verdict{Foreign: true, Reason: ReasonDiffer}
	case haveRow:
		return Verdict{Foreign: true, Reason: ReasonRowOnly}
	case haveFile:
		return Verdict{Foreign: true, Reason: ReasonFileOnly}
	}
	// neither: first start, or an old install upgrading in place
	n, err := p.LiveSessions(ctx)
	if err != nil {
		return Verdict{Foreign: true, Reason: ReasonUnreadable}
	}
	if n > 0 {
		lived, err := livedIn(ctx, p, now())
		if err != nil {
			return Verdict{Foreign: true, Reason: ReasonUnreadable}
		}
		if !lived {
			return Verdict{Foreign: true, Reason: ReasonBare}
		}
	}
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

// livedIn is the strict rule for an old install with no id yet: ALL of messageboard.db has messages, api_key predates now by more than a minute, and the folder holds something besides the databases
// and the tokens.
func livedIn(ctx context.Context, p Probe, now time.Time) (bool, error) {
	has, err := p.BoardHasMessages(ctx)
	if err != nil || !has {
		return false, err
	}
	fi, err := os.Lstat(filepath.Join(p.Dir, "api_key"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if !fi.Mode().IsRegular() || now.Sub(fi.ModTime()) <= time.Minute {
		return false, nil
	}
	entries, err := os.ReadDir(p.Dir)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		switch name := strings.ToLower(e.Name()); {
		case strings.HasPrefix(name, "sessions.db"), strings.HasPrefix(name, "messageboard.db"):
		case name == "api_key", name == "cli-token", name == "login_token", name == "coral-server.lock", name == strings.ToLower(FileName):
		default:
			return true, nil
		}
	}
	return false, nil
}

// readFile reads the id file: at most maxFile bytes, 32 hex digits on the first line and an optional "made at <path>" second line. A malformed file is an error (FOREIGN).
func readFile(dir string) (id, madeAt string, err error) {
	f, err := os.Open(filepath.Join(dir, FileName))
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
	if _, err := os.Stat(path); err != nil {
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
		if r, err := filepath.EvalSymlinks(p); err == nil {
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

// clean makes text from a file safe for a log line or a notice: control and format characters dropped, capped at 120 characters.
func clean(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if n++; n > 120 {
			b.WriteString("...")
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

// LogLine is the one log line of a FOREIGN start.
func LogLine(v Verdict) string {
	line := "[data-dir] " + Notice + " Why: " + v.Reason + "."
	if v.Detail != "" {
		line += " A folder with the same id exists at " + v.Detail + "."
	}
	return line
}
