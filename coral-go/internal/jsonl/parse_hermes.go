package jsonl

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/hermesdb"
)

// Hermes's sessions (#11831) are rows of its state.db (internal/hermesdb), not a transcript file. ParseHermesMessages turns rows, oldest first, into the chat's messages the way the Pi and Claude parsers do: a
// user turn, an assistant reply with its tool calls, a tool's result. A row is whatever the model, a tool or the person wrote: it is cut at the chat's bounds (a message at piMaxText, a tool's output at 10 KB) and
// never trusted to be well formed (a tool_calls column that is not JSON, or an arguments string that is not, is shown as far as it reads). The system rows (Hermes's prompt) are not turns. The caller redacts.

// ParseHermesMessages is the chat's messages for rows. A tool call's name is remembered by its id, so a result row that names no tool of its own is named by its call.
func ParseHermesMessages(rows []hermesdb.Message) []map[string]any {
	names := map[string]string{}
	var out []map[string]any
	for _, m := range rows {
		m = validHermesRow(m)
		ts := hermesTime(m.At)
		switch m.Role {
		case "user":
			text := truncate(strings.TrimSpace(m.Content), piMaxText)
			if text == "" || isSystemInjected(text) {
				continue
			}
			out = append(out, map[string]any{"type": "user", "timestamp": ts, "content": text})
		case "assistant":
			if e := hermesAssistant(m, ts, names); e != nil {
				out = append(out, e)
			}
		case "tool":
			out = append(out, hermesToolResult(m, ts, names))
		}
	}
	return out
}

// hermesTime is a row's epoch seconds as RFC 3339 UTC, "" when it has none.
func hermesTime(at float64) string {
	if at <= 0 {
		return ""
	}
	sec := int64(at)
	return time.Unix(sec, int64((at-float64(sec))*1e9)).UTC().Format(time.RFC3339Nano)
}

// hermesCall is one entry of an assistant row's tool_calls column (OpenAI's shape).
type hermesCall struct {
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

func hermesAssistant(m hermesdb.Message, ts string, names map[string]string) map[string]any {
	text := truncate(strings.TrimSpace(m.Content), piMaxText)
	uses := []map[string]any{}
	if strings.TrimSpace(m.ToolCalls) != "" {
		var raw []json.RawMessage
		if json.Unmarshal([]byte(m.ToolCalls), &raw) == nil {
			for _, r := range raw {
				var c hermesCall
				if json.Unmarshal(r, &c) != nil || c.Function.Name == "" {
					continue
				}
				uses = append(uses, hermesToolUse(c, names))
			}
		}
	}
	if text == "" && len(uses) == 0 {
		return nil
	}
	return map[string]any{"type": "assistant", "timestamp": ts, "content": text, "text": text, "tool_uses": uses}
}

func hermesToolUse(c hermesCall, names map[string]string) map[string]any {
	entry := map[string]any{"name": c.Function.Name, "tool_use_id": c.ID}
	var args map[string]any
	_ = json.Unmarshal([]byte(c.Function.Arguments), &args) // arguments that are not a JSON object read as none
	str := func(k string) string { s, _ := args[k].(string); return s }
	summary := ""
	if cmd := str("command"); cmd != "" {
		entry["command"] = truncate(cmd, piMaxText)
		summary = truncate(cmd, 200)
	}
	if summary == "" {
		for _, k := range []string{"path", "file_path", "pattern", "query", "url"} {
			if s := str(k); s != "" {
				summary = truncate(s, 200)
				break
			}
		}
	}
	if summary == "" {
		summary = c.Function.Name
	}
	entry["input_summary"] = summary
	if c.ID != "" {
		names[c.ID] = c.Function.Name
	}
	return entry
}

// hermesToolResult is a tool row: its output (the "output" of the JSON Hermes stores, else the content as it is), failed when the JSON's exit_code is not 0.
func hermesToolResult(m hermesdb.Message, ts string, names map[string]string) map[string]any {
	name := m.ToolName
	if name == "" {
		name = names[m.ToolCallID]
	}
	content, failed := m.Content, false
	var res struct {
		Output   *string `json:"output"`
		ExitCode *int    `json:"exit_code"`
	}
	if json.Unmarshal([]byte(m.Content), &res) == nil {
		if res.Output != nil {
			content = *res.Output
		}
		failed = res.ExitCode != nil && *res.ExitCode != 0
	}
	return map[string]any{"type": "tool_result", "timestamp": ts, "content": truncateContent(content), "tool_name": name, "tool_use_id": m.ToolCallID, "is_error": failed}
}

// validHermesRow is a row with every text valid UTF-8: the rows are raw SQLite text written by an agent CLI, which no JSON decoder has cleaned (a Pi line has), and a byte that is not text would reach the chat, the
// search and the excerpts as it is (the fuzz target found it, #12040). Invalid bytes become U+FFFD.
func validHermesRow(m hermesdb.Message) hermesdb.Message {
	const bad = "\uFFFD"
	m.Role = strings.ToValidUTF8(m.Role, bad)
	m.Content = strings.ToValidUTF8(m.Content, bad)
	m.ToolCalls = strings.ToValidUTF8(m.ToolCalls, bad)
	m.ToolName = strings.ToValidUTF8(m.ToolName, bad)
	m.ToolCallID = strings.ToValidUTF8(m.ToolCallID, bad)
	m.FinishReason = strings.ToValidUTF8(m.FinishReason, bad)
	return m
}
