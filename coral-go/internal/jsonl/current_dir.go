package jsonl

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// Where an agent is NOW (#11704, the operator: the Files panel said the same folder for every agent). Coral knows the folder an agent was launched in; the agents of a team are all launched in one folder and make
// their own worktrees, so the folder, branch, commit and changed files of the launch folder are the same for all of them. Claude writes the shell's current directory ("cwd") on every line of its transcript; the
// newest one is where the agent is. It is read from the end of the file, cached by the file's size and modification time, and is only TEXT here: the caller decides whether it is a place Coral may look at.

const (
	curDirTail = 64 << 10
	curDirMax  = 2048 // entries kept
	curDirLen  = 4096 // the longest path kept
)

type curDirEntry struct {
	mu       sync.Mutex
	path     string
	resolved time.Time
	size     int64
	mtime    int64
	read     bool
	dir      string
}

// CurrentDirectory is the newest working directory a Claude session's transcript names, or "" (not a Claude session, no transcript, no line with a directory, or one that is not a plain absolute path).
func (r *SessionReader) CurrentDirectory(sessionID, launchDir, agentType string) string {
	if agentType != at.Claude || !transcriptlink.IsSessionID(sessionID) {
		return ""
	}
	r.curMu.Lock()
	if r.curDirs == nil || len(r.curDirs) >= curDirMax {
		r.curDirs = map[string]*curDirEntry{}
	}
	e := r.curDirs[sessionID]
	if e == nil {
		e = &curDirEntry{}
		r.curDirs[sessionID] = e
	}
	r.curMu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.path == "" {
		if !e.resolved.IsZero() && lastMessageSince(e.resolved) < lastMessagePathTTL {
			return ""
		}
		e.resolved = lastMessageNow()
		e.path = resolveTranscriptPathMode(sessionID, launchDir, agentType, true)
		if e.path == "" {
			return ""
		}
	}
	fi, err := os.Stat(e.path)
	if err != nil || !fi.Mode().IsRegular() {
		e.path, e.read = "", false
		return ""
	}
	if e.read && fi.Size() == e.size && fi.ModTime().UnixNano() == e.mtime {
		return e.dir
	}
	if dir, ok := readCurrentDirectory(e.path, agentType, fi.Size()); ok || !e.read {
		e.dir = dir // a read that found none keeps the last one found (a long tool result can fill the tail)
	}
	e.size, e.mtime, e.read = fi.Size(), fi.ModTime().UnixNano(), true
	return e.dir
}

// readCurrentDirectory reads the last curDirTail bytes and returns the newest "cwd" it holds.
func readCurrentDirectory(path, agentType string, size int64) (string, bool) {
	f, err := openTranscript(path, agentType)
	if err != nil {
		return "", false
	}
	defer f.Close()
	from := size - curDirTail
	if from < 0 {
		from = 0
	}
	buf := make([]byte, size-from)
	if _, err := f.ReadAt(buf, from); err != nil && err != io.EOF {
		return "", false
	}
	lines := bytes.Split(buf, []byte("\n"))
	if from > 0 && len(lines) > 0 {
		lines = lines[1:] // the first line is cut by where the read began
	}
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"cwd"`)) {
			continue
		}
		var e struct {
			CWD string `json:"cwd"`
		}
		if json.Unmarshal(lines[i], &e) != nil || !plainAbsolutePath(e.CWD) {
			continue
		}
		return e.CWD, true
	}
	return "", false
}

// plainAbsolutePath: an absolute path of printable characters, not longer than curDirLen: nothing a line of text, a terminal or a URL could make of it.
func plainAbsolutePath(p string) bool {
	if p == "" || len(p) > curDirLen || strings.TrimSpace(p) != p {
		return false
	}
	if !(strings.HasPrefix(p, "/") || (len(p) > 2 && p[1] == ':' && (p[2] == '\\' || p[2] == '/'))) {
		return false
	}
	for _, c := range p {
		if unicode.IsControl(c) || unicode.Is(unicode.Cf, c) || c == '\u2028' || c == '\u2029' {
			return false
		}
	}
	return true
}
