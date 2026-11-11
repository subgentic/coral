package jsonl

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// A /compact or a /clear writes no usage of its own: the number the card shows (the last model turn's context) stays the pre-reset one until the agent's next reply (#15055). The transcript does
// say it happened: a compaction is a system entry (subtype compact_boundary, some versions carrying postTokens), a clear is the command's own user entry. ContextReset reads the transcript's end
// and reports whether the newest of those is newer than the newest model turn, so the list can stop publishing the old percentage.

// ContextReset says a reset came after the session's newest model turn. PostTokens is the context size right after a compaction when the CLI wrote it, else 0 (unknown until the next turn).
type ContextReset struct {
	Reset      bool
	PostTokens int
}

const contextResetMax = 4096 // entries kept

type contextResetEntry struct {
	mu       sync.Mutex
	path     string
	resolved time.Time
	size     int64
	mtime    int64
	read     bool
	res      ContextReset
}

// ContextReset is cached by the file's size and modification time as LastMessage is: an unchanged file is not read, a changed one reads only its end. Only Claude transcripts carry these entries;
// any other agent type, or a session with no transcript, reports no reset.
func (r *SessionReader) ContextReset(sessionID, workingDir, agentType string) ContextReset {
	if agentType != at.Claude || !transcriptlink.IsSessionID(sessionID) {
		return ContextReset{}
	}
	r.lastMu.Lock()
	if r.contextResets == nil || len(r.contextResets) >= contextResetMax {
		r.contextResets = map[string]*contextResetEntry{}
	}
	e := r.contextResets[sessionID]
	if e == nil {
		e = &contextResetEntry{}
		r.contextResets[sessionID] = e
	}
	r.lastMu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.path == "" {
		if !e.resolved.IsZero() && time.Since(e.resolved) < lastMessagePathTTL {
			return ContextReset{}
		}
		e.resolved = time.Now()
		e.path = resolveTranscriptPathMode(sessionID, workingDir, agentType, true)
		if e.path == "" {
			return ContextReset{}
		}
	}
	fi, err := os.Stat(e.path)
	if err != nil || !fi.Mode().IsRegular() {
		e.path, e.read = "", false
		return ContextReset{}
	}
	if e.read && fi.Size() == e.size && fi.ModTime().UnixNano() == e.mtime {
		return e.res
	}
	e.res = readContextReset(e.path, agentType, fi.Size())
	e.size, e.mtime, e.read = fi.Size(), fi.ModTime().UnixNano(), true
	return e.res
}

// readContextReset reads the end of the file, widening it until a model turn or a reset is in what was read.
func readContextReset(path, agentType string, size int64) ContextReset {
	f, err := openTranscript(path, agentType)
	if err != nil {
		return ContextReset{}
	}
	defer f.Close()
	for n := int64(lastMessageTail); ; n *= 4 {
		if n > size {
			n = size
		}
		buf := make([]byte, n)
		got, err := f.ReadAt(buf, size-n)
		if err != nil && err != io.EOF {
			return ContextReset{}
		}
		buf = buf[:got]
		if size-n > 0 { // the read began inside a line: what is left of it is not one
			if i := bytes.IndexByte(buf, '\n'); i >= 0 {
				buf = buf[i+1:]
			} else {
				buf = nil
			}
		}
		if res, found := contextResetIn(buf); found {
			return res
		}
		if n >= size || n >= lastMessageTailMax {
			return ContextReset{}
		}
	}
}

// contextResetIn walks complete lines newest first: the first model turn with usage means no reset since; the first compaction boundary or clear command means one. found is false when neither is
// in buf.
func contextResetIn(buf []byte) (ContextReset, bool) {
	lines := bytes.Split(buf, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Type      string `json:"type"`
			Subtype   string `json:"subtype"`
			Sidechain bool   `json:"isSidechain"`
			Compact   struct {
				PostTokens int `json:"postTokens"`
			} `json:"compactMetadata"`
			Message struct {
				Content json.RawMessage `json:"content"`
				Usage   json.RawMessage `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil || entry.Sidechain {
			continue
		}
		switch {
		case entry.Type == "assistant" && len(entry.Message.Usage) > 0 && string(entry.Message.Usage) != "null":
			return ContextReset{}, true
		case entry.Type == "system" && entry.Subtype == "compact_boundary":
			return ContextReset{Reset: true, PostTokens: entry.Compact.PostTokens}, true
		case entry.Type == "user" && isClearCommand(entry.Message.Content):
			return ContextReset{Reset: true}, true
		}
	}
	return ContextReset{}, false
}

// isClearCommand is the user entry the CLI writes for a typed /clear: the command's name in its own tag.
func isClearCommand(content json.RawMessage) bool {
	if len(content) == 0 {
		return false
	}
	var s string
	if json.Unmarshal(content, &s) != nil {
		return false
	}
	return strings.Contains(s, "<command-name>/clear</command-name>")
}
