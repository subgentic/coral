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
	"unicode/utf8"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// The last message of a session, for the phone UI's list (#11097): who said it (the person or the agent), its text and when. It is read from the transcript's tail through the same entry parsers
// the chat uses, so it is the same text the chat shows; a tool call alone, a tool result and what Coral typed into the agent (a nudge, a task notice) are not a message here.

// LastMessage is a session's newest message that has text.
type LastMessage struct {
	Role string `json:"role"` // "user" or "assistant"
	Text string `json:"text"` // plain: one line, control characters dropped, at most lastMessageMaxRunes
	At   string `json:"at"`   // the entry's timestamp as the transcript wrote it, "" when it has none
}

const (
	// lastMessageTail is the first read of a transcript's end; a long last line (a big tool result) widens it up to lastMessageTailMax.
	lastMessageTail    = 64 << 10
	lastMessageTailMax = 4 << 20
	// lastMessageMaxRunes bounds the text kept (the route cuts it shorter, after redacting).
	lastMessageMaxRunes = 600
	lastMessageMax      = 4096 // entries kept
	lastMessagePathTTL  = 5 * time.Second
)

// lastMessageReadHook is a test seam: it is told how many bytes a read took.
var lastMessageReadHook func(n int64)

// lastMessageEntry is what is known of one session's file: where it is, what it was when last read, and what the last message was.
type lastMessageEntry struct {
	mu       sync.Mutex
	path     string
	resolved time.Time
	size     int64
	mtime    int64
	read     bool
	msg      LastMessage
	ok       bool
}

// LastMessage is the newest message with text of a session's transcript, cached by the file's size and modification time: a list that polls every few seconds reads a file again only when it changed,
// and then only its end. ok is false when the session has no transcript or no message yet.
func (r *SessionReader) LastMessage(sessionID, workingDir, agentType string) (LastMessage, bool) {
	if !transcriptlink.IsSessionID(sessionID) {
		return LastMessage{}, false
	}
	r.lastMu.Lock()
	if r.lastMessages == nil || len(r.lastMessages) >= lastMessageMax { // sessions that ended
		r.lastMessages = map[string]*lastMessageEntry{}
	}
	e := r.lastMessages[sessionID]
	if e == nil {
		e = &lastMessageEntry{}
		r.lastMessages[sessionID] = e
	}
	r.lastMu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.path == "" {
		if !e.resolved.IsZero() && time.Since(e.resolved) < lastMessagePathTTL {
			return LastMessage{}, false
		}
		e.resolved = time.Now()
		e.path = resolveTranscriptPathMode(sessionID, workingDir, agentType, true)
		if e.path == "" {
			return LastMessage{}, false
		}
	}
	fi, err := os.Stat(e.path)
	if err != nil || !fi.Mode().IsRegular() {
		e.path, e.read = "", false
		return LastMessage{}, false
	}
	if e.read && fi.Size() == e.size && fi.ModTime().UnixNano() == e.mtime {
		return e.msg, e.ok
	}
	e.msg, e.ok = readLastMessage(e.path, agentType, fi.Size())
	e.size, e.mtime, e.read = fi.Size(), fi.ModTime().UnixNano(), true
	return e.msg, e.ok
}

// readLastMessage reads the end of the file, widening it while the last message is not in what was read.
func readLastMessage(path, agentType string, size int64) (LastMessage, bool) {
	f, err := openTranscript(path, agentType)
	if err != nil {
		return LastMessage{}, false
	}
	defer f.Close()
	for n := int64(lastMessageTail); ; n *= 4 {
		if n > size {
			n = size
		}
		buf := make([]byte, n)
		got, err := f.ReadAt(buf, size-n)
		if err != nil && err != io.EOF {
			return LastMessage{}, false
		}
		if lastMessageReadHook != nil {
			lastMessageReadHook(int64(got))
		}
		buf = buf[:got]
		if size-n > 0 { // the read began inside a line: what is left of it is not one
			if i := bytes.IndexByte(buf, '\n'); i >= 0 {
				buf = buf[i+1:]
			} else {
				buf = nil
			}
		}
		if m, ok := lastMessageIn(buf, agentType); ok {
			return m, true
		}
		if n >= size || n >= lastMessageTailMax {
			return LastMessage{}, false
		}
	}
}

// lastMessageIn is the newest message with text among complete lines, newest first.
func lastMessageIn(buf []byte, agentType string) (LastMessage, bool) {
	lines := bytes.Split(buf, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		var entry map[string]any
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		msgs := parseTranscriptEntry(entry, map[string]string{}, agentType)
		for j := len(msgs) - 1; j >= 0; j-- {
			m := msgs[j]
			role, _ := m["type"].(string)
			if (role != "user" && role != "assistant") || m["local_command"] == true {
				continue
			}
			text, _ := m["text"].(string)
			if text == "" {
				text, _ = m["content"].(string)
			}
			text = plainLine(text)
			if text == "" || (role == "user" && agent.IsCoralDelivery(text)) {
				continue
			}
			at, _ := m["timestamp"].(string)
			return LastMessage{Role: role, Text: text, At: at}, true
		}
	}
	return LastMessage{}, false
}

// plainLine is text as one line of plain words: whitespace runs are one space, control and format characters are dropped, and it is cut at lastMessageMaxRunes characters.
func plainLine(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && !unicode.IsSpace(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > lastMessageMaxRunes {
		s = string([]rune(s)[:lastMessageMaxRunes])
	}
	return s
}

// CachedLastMessage is what an earlier LastMessage read found, without opening anything: for a list's first paint.
func (r *SessionReader) CachedLastMessage(sessionID string) (LastMessage, bool) {
	r.lastMu.Lock()
	e := r.lastMessages[sessionID]
	r.lastMu.Unlock()
	if e == nil {
		return LastMessage{}, false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.msg, e.read && e.ok
}
