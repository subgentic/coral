package jsonl

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/hermesdb"
)

// FuzzParseHermesMessages (#12040): a Hermes state.db is written by an agent CLI, and what the model and its tools printed ends up in its rows: the content, the tool calls (a JSON text), a tool's name and result.
// Any rows, however shaped (a tool_calls that is not JSON or is the wrong JSON, an id that is not a string, a result that is JSON of another shape, bytes that are not UTF-8, a huge text), never panic the parser and
// give only messages of the chat's kinds, with text that is valid and bounded, and tool calls with a string name and id. Seeds are rows of the shapes Hermes v0.22.5 writes and the odd ones below.
// go test -fuzz FuzzParseHermesMessages -fuzztime 10m ./internal/jsonl/ fuzzes.
func FuzzParseHermesMessages(f *testing.F) {
	type row struct{ role, content, calls, name, id string }
	for _, s := range []row{
		{"user", "hello", "", "", ""},
		{"assistant", "ok", `[{"id":"c1","function":{"name":"terminal","arguments":"{\"command\":\"ls -la\"}"}}]`, "", ""},
		{"tool", `{"output":"a b","exit_code":0}`, "", "terminal", "c1"},
		{"tool", `{"output":"boom","exit_code":2}`, "", "", "c1"},
		{"assistant", "", `[{"id":1,"function":{"name":2,"arguments":3}}]`, "", ""},
		{"assistant", "x", `{"not":"a list"}`, "", ""},
		{"assistant", "x", `[null, 5, "s", {"function":null}]`, "", ""},
		{"tool", `[1,2,3]`, "", "", ""},
		{"tool", `{"output":5,"exit_code":"x"}`, "", "n", "i"},
		{"user", strings.Repeat("é", 400000), "", "", ""},
		{"system", "ignored role", "", "", ""},
		{"assistant", "\xff\xfe bad bytes", `[{"id":"a","function":{"name":"edit","arguments":"{\"path\":\"\xff\"}"}}]`, "", ""},
		{"user", "[Task #1 do it]", "", "", ""},
	} {
		f.Add(s.role, s.content, s.calls, s.name, s.id, 1788000000.5)
	}
	f.Fuzz(func(t *testing.T, role, content, calls, name, id string, at float64) {
		rows := []hermesdb.Message{
			{ID: 1, Role: "user", Content: "first", At: at},
			{ID: 2, Role: role, Content: content, ToolCalls: calls, ToolName: name, ToolCallID: id, At: at},
			{ID: 3, Role: "tool", Content: content, ToolName: name, ToolCallID: id, At: at},
		}
		for _, m := range ParseHermesMessages(rows) {
			switch m["type"] {
			case "user", "assistant", "tool_result":
			default:
				t.Fatalf("message type %v", m["type"])
			}
			for _, k := range []string{"content", "text", "thinking", "tool_name"} {
				if s, ok := m[k].(string); ok {
					if !utf8.ValidString(s) {
						t.Fatalf("%s is not valid UTF-8", k)
					}
					if len(s) > 4*piMaxText+64 {
						t.Fatalf("%s is %d bytes", k, len(s))
					}
				}
			}
			if tus, ok := m["tool_uses"].([]map[string]any); ok {
				for _, tu := range tus {
					if _, ok := tu["name"].(string); !ok {
						t.Fatalf("tool call name %v", tu["name"])
					}
					if _, ok := tu["tool_use_id"].(string); !ok {
						t.Fatalf("tool call id %v", tu["tool_use_id"])
					}
				}
			}
		}
	})
}
