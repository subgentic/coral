package jsonl

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// Coral Live's chat (#21094): the newest messages of one session, and only these: what a person typed to the agent and what the agent replied in words. It reads the transcript's tail through the
// same entry parsers the chat and last_message use, and then keeps an ALLOWLIST of entries (a typed user turn, an assistant reply with text), not a filter of roles: a user-role entry can be a tool result, a system
// reminder, a hook's text or Coral's own delivery, and an assistant entry can carry a tool call. Tool calls and results, thinking, attachments, slash commands and Coral's deliveries are never here.

// ChatMessage is one message of the chat window.
type ChatMessage struct {
	Role string // "user" (typed by a person) or "assistant" (the agent's words)
	Text string // plain, one line, at most chatMaxRunes
	At   string // the entry's timestamp as the transcript wrote it, "" when it has none
}

const (
	chatMaxRunes = 4096 // a message is read this far; the page shows far less and the caller cuts it again
	chatTailMin  = 128 << 10
)

// ChatSupported says whether chat is tested for this CLI: each has fixtures that show a tool result, a system reminder, a Coral delivery and a tool call stay out (chat_tail_test.go). A CLI not listed has no chat.
func ChatSupported(agentType string) bool {
	switch agentType {
	case at.Claude, at.Codex, at.Agy, at.Pi:
		return true
	}
	return false
}

// ChatTail returns the newest n chat messages of a session, oldest first. ok is false when the CLI has no tested chat, the session id is not one, or there is no transcript.
func (r *SessionReader) ChatTail(sessionID, workingDir, agentType string, n int) ([]ChatMessage, bool) {
	if n <= 0 || !ChatSupported(agentType) || !transcriptlink.IsSessionID(sessionID) {
		return nil, false
	}
	path := resolveTranscriptPathMode(sessionID, workingDir, agentType, true)
	if path == "" {
		return nil, false
	}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	f, err := openTranscript(path, agentType)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	size := fi.Size()
	for want := int64(chatTailMin); ; want *= 4 {
		if want > size {
			want = size
		}
		buf := make([]byte, want)
		got, err := f.ReadAt(buf, size-want)
		if err != nil && err != io.EOF {
			return nil, false
		}
		buf = buf[:got]
		if size-want > 0 { // the read began inside a line: what is left of it is not one
			if i := bytes.IndexByte(buf, '\n'); i >= 0 {
				buf = buf[i+1:]
			} else {
				buf = nil
			}
		}
		if nl := bytes.LastIndexByte(buf, '\n'); nl >= 0 && nl < len(buf)-1 { // a last line still being written is not read
			buf = buf[:nl+1]
		}
		msgs := chatMessagesIn(buf, agentType)
		if len(msgs) >= n || want >= size || want >= lastMessageTailMax {
			if len(msgs) > n {
				msgs = msgs[len(msgs)-n:]
			}
			return msgs, true
		}
	}
}

// chatMessagesIn is every chat message among complete lines, oldest first.
func chatMessagesIn(buf []byte, agentType string) []ChatMessage {
	var out []ChatMessage
	names := map[string]string{}
	for _, line := range bytes.Split(buf, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var entry map[string]any
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		if chatEntrySkipped(entry, agentType) {
			continue
		}
		for _, m := range parseTranscriptEntry(entry, names, agentType) {
			if c, ok := chatMessageOf(m); ok {
				out = append(out, c)
			}
		}
	}
	return out
}

// chatEntrySkipped says a whole transcript entry is context the CLI wrote, not words a person typed or an agent said (QA on #21094). Claude Code marks a compaction summary (the whole project state)
// isCompactSummary, text it injected itself isMeta, a note only the transcript shows isVisibleInTranscriptOnly, and a subagent's turns isSidechain. Pi's extensions add "custom_message" entries and its
// compaction writes "compaction" and "branch_summary": only a plain "message" entry is chat. Codex writes its compaction as a "compacted" item and its context as developer, system and turn_context items, and
// its parser reads only user and assistant messages; agy's CONTEXT_SUMMARY block is cut by its parser and caught again by contextText.
func chatEntrySkipped(entry map[string]any, agentType string) bool {
	switch agentType {
	case at.Pi:
		t, _ := entry["type"].(string)
		return t != "message"
	case at.Codex, at.Agy, at.Antigravity, at.Gemini:
		return false
	}
	for _, k := range []string{"isCompactSummary", "isMeta", "isVisibleInTranscriptOnly", "isSidechain"} {
		if entry[k] == true {
			return true
		}
	}
	return false
}

// contextText says a user turn is context a CLI put in, by its opening words, for the entries that carry no flag (a defence behind chatEntrySkipped): a compaction summary, a notification, a loaded skill.
func contextText(text string) bool {
	t := strings.TrimSpace(text)
	for _, p := range []string{
		"This session is being continued from a previous conversation",
		"[SYSTEM NOTIFICATION",
		"Base directory for this skill:",
		"Another language model started to solve this problem", // Codex's compaction summary prefix
		"<summary>", "<CONTEXT_SUMMARY>", "<system-reminder>", "<environment_context>",
	} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return strings.Contains(t, "<CONTEXT_SUMMARY>")
}

// chatMessageOf is the allowlist: a parsed entry is a chat message only when it is a user turn a person typed or an assistant turn with words. Anything else, whatever its role, is not.
func chatMessageOf(m map[string]any) (ChatMessage, bool) {
	role, _ := m["type"].(string)
	if role != "user" && role != "assistant" {
		return ChatMessage{}, false // a tool result, an attachment entry, anything the parsers add later
	}
	if m["local_command"] == true {
		return ChatMessage{}, false
	}
	if m["is_error"] == true { // a provider's error text (Pi's 400) is not the agent's words
		return ChatMessage{}, false
	}
	if a, ok := m["attachments"]; ok && a != nil { // a pasted image or file: never
		return ChatMessage{}, false
	}
	text, _ := m["text"].(string)
	if text == "" {
		text, _ = m["content"].(string)
	}
	if role == "user" {
		text = agent.PersonText(text)
	}
	text = plainLineMax(text, chatMaxRunes)
	if text == "" || (role == "user" && (agent.IsCoralDelivery(text) || coralInjected(text) || contextText(text))) {
		return ChatMessage{}, false
	}
	at, _ := m["timestamp"].(string)
	return ChatMessage{Role: role, Text: text, At: at}, true
}

// coralInjected says a user turn carries Coral's own text, which the delivery patterns miss: the launch prompt Coral types into a new agent (it names the board and how to use coral-board) and the session marker
// Coral appends to a first turn. Such a turn is dropped whole, even if a person's words are in it: chat leaves out a message before it shows Coral's instructions.
func coralInjected(text string) bool {
	return strings.Contains(text, at.CoralSessionMarkerPrefix) ||
		strings.Contains(text, "automatically joined to message board") ||
		strings.Contains(text, "coral-board ") || strings.Contains(text, "coral-agent ")
}
