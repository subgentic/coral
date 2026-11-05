package main

import (
	"encoding/json"
	"os"
	"strings"
)

// MOCK_AGENT_REPLIES=<file> scripts the mock's answers (#13180, for the demo film's live chat): a JSON array of
//
//	{"when": "wind chill", "text": "Done: ...", "tool": {"name": "Bash", "command": "go test ./...", "output": "ok  skyline 0.4s"}}
//
// A turn takes the first entry whose "when" (compared without case) is in the prompt; a prompt no keyword matches takes the next
// entry with no "when", in order. An entry's text replaces the canned answer and its optional tool is the one tool step of the
// turn (a script entry without a tool has none). With the variable unset, a file that cannot be read or is not that array, or no
// entry left for the turn, the mock answers as it always did.
type scriptedReply struct {
	When string        `json:"when"`
	Text string        `json:"text"`
	Tool *scriptedTool `json:"tool"`
}

type scriptedTool struct {
	Name    string `json:"name"`
	Command string `json:"command"`
	Output  string `json:"output"`
}

// loadScriptedReplies reads MOCK_AGENT_REPLIES; nil when the script is not in use or not usable.
func loadScriptedReplies() []scriptedReply {
	p := os.Getenv("MOCK_AGENT_REPLIES")
	if p == "" {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var rs []scriptedReply
	if json.Unmarshal(b, &rs) != nil {
		return nil
	}
	out := rs[:0]
	for _, r := range rs {
		if strings.TrimSpace(r.Text) != "" {
			out = append(out, r)
		}
	}
	return out
}

// scriptedFor is the entry for this turn's prompt, or nil. It counts the unkeyed entries it has handed out.
func (t *transcript) scriptedFor(prompt string) *scriptedReply {
	if t.script == nil && !t.scriptRead {
		t.script = loadScriptedReplies()
		t.scriptRead = true
	}
	lp := strings.ToLower(prompt)
	for i := range t.script {
		if w := strings.ToLower(strings.TrimSpace(t.script[i].When)); w != "" && strings.Contains(lp, w) {
			return &t.script[i]
		}
	}
	n := 0
	for i := range t.script {
		if strings.TrimSpace(t.script[i].When) != "" {
			continue
		}
		if n == t.unkeyed {
			t.unkeyed++
			return &t.script[i]
		}
		n++
	}
	return nil
}
