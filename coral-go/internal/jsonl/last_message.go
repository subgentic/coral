package jsonl

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
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

// lastMessageBytes counts the bytes every LastMessage read has taken since the process started (LastMessageBytesRead): a load measurement takes the difference over a poll.
var lastMessageBytes atomic.Int64

// LastMessageBytesRead is how many bytes the last-message tail reads have taken in all.
func LastMessageBytesRead() int64 { return lastMessageBytes.Load() }

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
	lineEnd  int64  // where the last complete line the reader has taken ends: the next read starts here (#11123)
	anchor   []byte // the last bytes before lineEnd (at most lastMessageAnchor): an append is trusted only when the file still has them there, so a file rewritten or replaced in place is read afresh
}

// lastMessageAnchor is how many bytes before the read position are kept to tell an appended file from a rewritten one.
const lastMessageAnchor = 64

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
	if agentType == at.Pi {
		// Pi's /new starts another file in the session's folder: the newest file is looked for again on every read (a glob of that one folder, and the walk of Pi's own folder behind its own miss cache), and a
		// new one is read from its start (#11123, QA).
		if np := resolveTranscriptPathMode(sessionID, workingDir, agentType, true); np != "" && np != e.path {
			e.path, e.read = np, false
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
	appended := false
	if e.read && fi.Size() > e.size && fi.Size() >= e.lineEnd {
		// The file grew (strictly: the same size with another time is a rewrite): only what was appended is read, from the end of the last complete line, at most lastMessageTailMax of it; when it holds no
		// message the one found before is still the last. It is an append only when the bytes just before where the read starts are still the ones read last time (a file replaced or rewritten in place, even
		// to a longer one, has others there): then the tail is read afresh.
		if m, ok, end, anchor, same := readAppendedMessage(e.path, agentType, e.lineEnd, fi.Size(), e.anchor); same {
			appended = true
			if ok {
				e.msg, e.ok = m, true
			}
			e.lineEnd, e.anchor = end, anchor
		}
	}
	if !appended {
		e.msg, e.ok, e.lineEnd, e.anchor = readLastMessage(e.path, agentType, fi.Size())
	}
	e.size, e.mtime, e.read = fi.Size(), fi.ModTime().UnixNano(), true
	return e.msg, e.ok
}

// readAppendedMessage reads the bytes from from to size (the newest lastMessageTailMax of them when there are more), together with the anchor bytes before from, and returns the newest message with text in
// the complete lines after from, where the last complete line ends and the new anchor. same is false when the anchor is no longer what the file has there: the file is not the one that was read.
func readAppendedMessage(path, agentType string, from, size int64, anchor []byte) (m LastMessage, ok bool, lineEnd int64, newAnchor []byte, same bool) {
	f, err := openTranscript(path, agentType)
	if err != nil {
		return LastMessage{}, false, from, anchor, false
	}
	defer f.Close()
	start := from - int64(len(anchor))
	partial := false
	if size-from > lastMessageTailMax { // more was written than is worth reading: its end, and no anchor to check
		start, partial = size-lastMessageTailMax, true
	}
	buf := make([]byte, size-start)
	got, err := f.ReadAt(buf, start)
	if err != nil && err != io.EOF {
		return LastMessage{}, false, from, anchor, false
	}
	lastMessageBytes.Add(int64(got))
	if lastMessageReadHook != nil {
		lastMessageReadHook(int64(got))
	}
	buf = buf[:got]
	if !partial {
		if len(buf) < len(anchor) || !bytes.Equal(buf[:len(anchor)], anchor) {
			return LastMessage{}, false, from, anchor, false
		}
		buf, start = buf[len(anchor):], from
	} else { // began inside a line
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			start += int64(i) + 1
			buf = buf[i+1:]
		} else {
			return LastMessage{}, false, size, nil, true
		}
	}
	nl := bytes.LastIndexByte(buf, '\n')
	if nl < 0 {
		return LastMessage{}, false, start, anchor, true // only a line still being written
	}
	complete := buf[:nl+1]
	m, ok = lastMessageIn(complete, agentType)
	lineEnd = start + int64(nl) + 1
	// the new anchor: the last bytes before lineEnd, from what was read (the old anchor's bytes too when little was added)
	whole := append(append([]byte{}, anchor...), complete...)
	if partial {
		whole = complete
	}
	if len(whole) > lastMessageAnchor {
		whole = whole[len(whole)-lastMessageAnchor:]
	}
	return m, ok, lineEnd, append([]byte{}, whole...), true
}

// readLastMessage reads the end of the file, widening it while the last message is not in what was read.
func readLastMessage(path, agentType string, size int64) (LastMessage, bool, int64, []byte) {
	f, err := openTranscript(path, agentType)
	if err != nil {
		return LastMessage{}, false, 0, nil
	}
	defer f.Close()
	lineEnd := size
	var anchor []byte
	for n := int64(lastMessageTail); ; n *= 4 {
		if n > size {
			n = size
		}
		buf := make([]byte, n)
		got, err := f.ReadAt(buf, size-n)
		if err != nil && err != io.EOF {
			return LastMessage{}, false, 0, nil
		}
		lastMessageBytes.Add(int64(got))
		if lastMessageReadHook != nil {
			lastMessageReadHook(int64(got))
		}
		buf = buf[:got]
		if nl := bytes.LastIndexByte(buf, '\n'); nl >= 0 && nl < len(buf)-1 { // a last line still being written is not read, and the next read starts at it
			lineEnd = size - n + int64(nl) + 1
			buf = buf[:nl+1]
		}
		if a := buf; len(a) > 0 && lineEnd == size-n+int64(len(a)) { // the bytes just before lineEnd, for the next append's check
			if len(a) > lastMessageAnchor {
				a = a[len(a)-lastMessageAnchor:]
			}
			anchor = append([]byte{}, a...)
		}
		if size-n > 0 { // the read began inside a line: what is left of it is not one
			if i := bytes.IndexByte(buf, '\n'); i >= 0 {
				buf = buf[i+1:]
			} else {
				buf = nil
			}
		}
		if m, ok := lastMessageIn(buf, agentType); ok {
			return m, true, lineEnd, anchor
		}
		if n >= size || n >= lastMessageTailMax {
			return LastMessage{}, false, lineEnd, anchor
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
