package jsonl

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// Pi's session files (#11088). Pi 1.4.0 writes one JSONL file per session, <session dir>/<timestamp>_<pi id>.jsonl, where Coral's Pi launch gives it --session-dir
// <data dir>/pi-sessions/<Coral session id>. Each line is an entry with a type: "session" (the header), "message" (a system, user, assistant, toolResult, bashExecution or
// custom message in entry.message, its content a string or blocks), "model_change", "thinking_level_change", "compaction", "branch_summary", "custom_message" and others the chat does not show.
// The format is documented in Pi's own docs (session-format.md, message-types.md), and the fixture in testdata/pi-1.4.0 is a real session with every text replaced.

// parsePiEntry turns one Pi entry into the chat's messages: a user turn, an assistant reply with its tool calls, a tool result. The system message (the prompt and tool list), usage,
// model and thinking-level changes, labels and the like are not turns. Each tool call is noted in toolUseNames for the result that names it.
func parsePiEntry(entry map[string]any, toolUseNames map[string]string) []map[string]any {
	timestamp, _ := entry["timestamp"].(string)
	switch etype, _ := entry["type"].(string); etype {
	case "message":
		msg, _ := entry["message"].(map[string]any)
		if msg == nil {
			return nil
		}
		switch role, _ := msg["role"].(string); role {
		case "user":
			return piUserTurn(piBlocksText(msg["content"]), timestamp)
		case "assistant":
			out := piAssistantTurn(msg, timestamp, toolUseNames)
			if stop, _ := msg["stopReason"].(string); stop == "aborted" {
				// The person pressed Stop (Esc) mid-turn: Pi ends the turn with stopReason "aborted" and errorMessage "Operation aborted". Claude records the same as a user text
				// "[Request interrupted by user]", which the chat shows as an interrupt and ends the working row on: the same text here, after whatever Pi had said (#11092).
				out = append(out, map[string]any{"type": "user", "timestamp": timestamp, "content": "[Request interrupted by user]"})
			}
			return out
		case "toolResult":
			return piToolResult(msg, timestamp, toolUseNames)
		case "bashExecution":
			// A command the person ran in Pi with "!" (not a tool call): shown as what they typed, like a slash command another CLI ran itself.
			if cmd, _ := msg["command"].(string); strings.TrimSpace(cmd) != "" {
				return []map[string]any{{"type": "user", "timestamp": timestamp, "content": "!" + truncate(cmd, 2000), "local_command": true}}
			}
		}
	case "custom_message":
		// An extension's message that Pi shows (display) and gives the model as a user message.
		if display, _ := entry["display"].(bool); display {
			return piUserTurn(piBlocksText(entry["content"]), timestamp)
		}
	}
	return nil
}

// piMaxText is the most of one message's text or one command the chat takes (about 1 MB; a tool's output, a write and thinking are cut at 10 KB): what an agent wrote into its session file is not a way to
// make the chat huge.
const piMaxText = 1 << 20

func piUserTurn(text, timestamp string) []map[string]any {
	text = truncate(strings.TrimSpace(text), piMaxText)
	if text == "" || isSystemInjected(text) {
		return nil
	}
	return []map[string]any{{"type": "user", "timestamp": timestamp, "content": text}}
}

// piBlocksText is a message's text: the string itself, or its text blocks joined, an image as "[image]".
func piBlocksText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var parts []string
		for _, raw := range c {
			b, _ := raw.(map[string]any)
			switch bt, _ := b["type"].(string); bt {
			case "text":
				if t, _ := b["text"].(string); t != "" {
					parts = append(parts, t)
				}
			case "image":
				parts = append(parts, "[image]")
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// piAssistantTurn is a reply: its text, its thinking and each tool call (named for the results to come). A reply Pi ended with an error (stopReason "error", the message in errorMessage) is shown with that
// message, flagged is_error: the extra-usage 400 is one.
func piAssistantTurn(msg map[string]any, timestamp string, toolUseNames map[string]string) []map[string]any {
	var text []string
	var thinking []string
	var toolUses []map[string]any
	if blocks, ok := msg["content"].([]any); ok {
		for _, raw := range blocks {
			b, _ := raw.(map[string]any)
			switch bt, _ := b["type"].(string); bt {
			case "text":
				if t, _ := b["text"].(string); t != "" {
					text = append(text, t)
				}
			case "thinking":
				if t, _ := b["thinking"].(string); strings.TrimSpace(t) != "" {
					thinking = append(thinking, t)
				}
			case "toolCall":
				toolUses = append(toolUses, piToolUse(b, toolUseNames))
			}
		}
	} else if s, ok := msg["content"].(string); ok && s != "" {
		text = append(text, s)
	}
	out := map[string]any{"type": "assistant", "timestamp": timestamp}
	isError := false
	if stop, _ := msg["stopReason"].(string); stop == "error" {
		if em, _ := msg["errorMessage"].(string); strings.TrimSpace(em) != "" {
			text = append(text, "Error: "+truncate(strings.TrimSpace(em), 2000))
			isError = true
		}
	}
	joined := truncate(strings.Join(text, "\n\n"), piMaxText)
	if joined == "" && len(thinking) == 0 && len(toolUses) == 0 {
		return nil
	}
	out["content"], out["text"], out["tool_uses"] = joined, joined, toolUses
	if len(thinking) > 0 {
		out["thinking"] = truncate(strings.Join(thinking, "\n\n"), 10000)
	}
	if isError {
		out["is_error"] = true
	}
	return []map[string]any{out}
}

// piToolUse is one tool call: its name and id (kept in toolUseNames), what it does and an input summary, by Pi's tools (bash, read, write, edit, grep, find, ls).
func piToolUse(b map[string]any, toolUseNames map[string]string) map[string]any {
	name, _ := b["name"].(string)
	id, _ := b["id"].(string)
	args, _ := b["arguments"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}
	str := func(k string) string { s, _ := args[k].(string); return s }
	entry := map[string]any{"name": name, "tool_use_id": id}
	summary := ""
	switch name {
	case "bash", "powershell":
		if cmd := str("command"); cmd != "" {
			entry["command"] = truncate(cmd, piMaxText)
			summary = truncate(cmd, 200)
		}
	case "write":
		summary = str("path")
		if c := str("content"); c != "" {
			entry["write_content"] = truncateContent(c)
		}
	case "edit":
		summary = str("path")
		// Pi's edit takes edits: [{oldText, newText}] (or oldText and newText directly): the first is shown.
		first := args
		if edits, ok := args["edits"].([]any); ok && len(edits) > 0 {
			if e, ok := edits[0].(map[string]any); ok {
				first = e
			}
		}
		for _, k := range []string{"oldText", "old_string", "old_text"} {
			if s, _ := first[k].(string); s != "" {
				entry["old_string"] = truncateContent(s)
				break
			}
		}
		for _, k := range []string{"newText", "new_string", "new_text"} {
			if s, _ := first[k].(string); s != "" {
				entry["new_string"] = truncateContent(s)
				break
			}
		}
	case "read", "ls":
		summary = str("path")
	case "grep", "find":
		summary = str("pattern")
		if p := str("path"); p != "" {
			summary += " in " + p
		}
	}
	if summary == "" {
		for _, k := range []string{"path", "command", "pattern", "query", "url"} {
			if s := str(k); s != "" {
				summary = truncate(s, 200)
				break
			}
		}
	}
	if summary == "" {
		summary = name
	}
	entry["input_summary"] = summary
	if id != "" {
		toolUseNames[id] = name
	}
	return entry
}

// piToolResult is a tool's output, matched to its call by toolCallId.
func piToolResult(msg map[string]any, timestamp string, toolUseNames map[string]string) []map[string]any {
	id, _ := msg["toolCallId"].(string)
	name, _ := msg["toolName"].(string)
	if name == "" {
		name = toolUseNames[id]
	}
	isError, _ := msg["isError"].(bool)
	return []map[string]any{{
		"type":        "tool_result",
		"timestamp":   timestamp,
		"content":     truncateContent(piBlocksText(msg["content"])),
		"tool_name":   name,
		"tool_use_id": id,
		"is_error":    isError,
	}}
}

// piWalkMissTTL is how long a session with no file in Pi's own sessions folder is not looked for again: the walk of that folder is not repeated on every poll of every Pi agent.
const piWalkMissTTL = 5 * time.Second

var (
	piWalkMu   sync.Mutex
	piWalkMiss = map[string]time.Time{}
	piWalkNow  = time.Now
	piWalkHook func() // a test counts the walks
)

// resolvePiTranscript is the file of a Coral Pi session: the newest .jsonl in <data dir>/pi-sessions/<session id>/ (Coral's launch gives Pi that folder with --session-dir, and /new starts another
// file in it), else a file with the session id in its name under Pi's own sessions folder. The session's folder must be a real folder: a link there (the agent can write in pi-sessions) is refused.
// "" when there is none yet.
func resolvePiTranscript(sessionID string) string {
	if !transcriptlink.IsSessionID(sessionID) { // joined into a path and matched in file names
		return ""
	}
	home, _ := os.UserHomeDir()
	dataDir := os.Getenv("CORAL_DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(home, ".coral")
	}
	dir := filepath.Join(dataDir, "pi-sessions", sessionID)
	if fi, err := os.Lstat(filepath.Dir(dir)); err == nil && !fi.IsDir() { // pi-sessions itself is Coral's folder, never a link
		return ""
	}
	if fi, err := os.Lstat(dir); err == nil {
		if !fi.IsDir() { // a link, a file: not the folder Coral made
			return ""
		}
		if matches, err := filepath.Glob(filepath.Join(dir, "*.jsonl")); err == nil && len(matches) > 0 {
			return newestFile(matches)
		}
	}
	piWalkMu.Lock()
	missedAt, missed := piWalkMiss[sessionID]
	piWalkMu.Unlock()
	if missed && piWalkNow().Sub(missedAt) < piWalkMissTTL {
		return ""
	}
	base := filepath.Join(os.Getenv("PI_CODING_AGENT_DIR"), "sessions")
	if os.Getenv("PI_CODING_AGENT_DIR") == "" {
		base = filepath.Join(home, ".pi", "agent", "sessions")
	}
	if piWalkHook != nil {
		piWalkHook()
	}
	var found []string
	_ = filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".jsonl") && strings.Contains(filepath.Base(path), sessionID) {
			found = append(found, path)
		}
		return nil
	})
	piWalkMu.Lock()
	defer piWalkMu.Unlock()
	if len(found) == 0 {
		if len(piWalkMiss) > 4096 { // sessions that ended
			piWalkMiss = map[string]time.Time{}
		}
		piWalkMiss[sessionID] = piWalkNow()
		return ""
	}
	delete(piWalkMiss, sessionID)
	sort.Strings(found)
	return newestFile(found)
}

// openPiTranscript opens a Pi session file through a root on its folder, so a link there (the agent can write in it) is never followed.
func openPiTranscript(path string) (*os.File, error) {
	root, err := safefs.OpenRoot(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer root.Close() // the file stays open
	f, _, err := root.Open(filepath.Base(path))
	return f, err
}

// piErrorTailBytes is how much of the end of a Pi session file is looked at for its last turn: an error is the last thing in the file, so the end is enough.
const piErrorTailBytes = 256 << 10

// PiLastError is the provider's error for the last turn of a Pi session, or "": the errorMessage of the newest assistant message (Pi 1.4.0 writes it with stopReason "error" when a model request
// fails: a refused account, an unsupported model, a rate limit), only while nothing came after it: a later user message (a retry) or a successful assistant message ends it (#11092).
func PiLastError(sessionID string) string {
	path := resolvePiTranscript(sessionID)
	if path == "" {
		return ""
	}
	f, err := openPiTranscript(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	if start := info.Size() - piErrorTailBytes; start > 0 {
		if _, err := f.Seek(start, 0); err != nil {
			return ""
		}
	}
	last := ""
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Role         string `json:"role"`
				StopReason   string `json:"stopReason"`
				ErrorMessage string `json:"errorMessage"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.Type != "message" {
			continue // also the first, cut line of a tail read
		}
		switch entry.Message.Role {
		case "assistant":
			last = ""
			if entry.Message.StopReason == "error" { // "aborted" is the person's own Stop (errorMessage "Operation aborted"), not a failure
				last = entry.Message.ErrorMessage
			} // a successful assistant message clears it
		case "user":
			last = "" // a new question: the retry is under way, and fails again with an error of its own
		}
	}
	return last
}
