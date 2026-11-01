package jsonl

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/hermesdb"
)

// #11831: a Hermes session's rows (hermesdb) as the chat's messages.

func hermesRows(rows ...hermesdb.Message) []hermesdb.Message { return rows }

func TestHermesRowsBecomeChatMessages(t *testing.T) {
	at := float64(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).Unix())
	rows := hermesRows(
		hermesdb.Message{ID: 1, Role: "user", Content: "list the files", At: at},
		hermesdb.Message{ID: 2, Role: "assistant", Content: "", At: at + 1, FinishReason: "tool_calls",
			ToolCalls: `[{"id":"call_1","type":"function","function":{"name":"terminal","arguments":"{\"command\":\"ls -la\"}"}}]`},
		hermesdb.Message{ID: 3, Role: "tool", Content: `{"output":"a.go\nb.go","exit_code":0}`, ToolName: "terminal", ToolCallID: "call_1", At: at + 2},
		hermesdb.Message{ID: 4, Role: "assistant", Content: "two files", At: at + 3, FinishReason: "stop"},
	)
	got := ParseHermesMessages(rows)
	require.Len(t, got, 4)
	assert.Equal(t, map[string]any{"type": "user", "timestamp": "2026-11-01T12:00:00Z", "content": "list the files"}, got[0])

	a := got[1]
	assert.Equal(t, "assistant", a["type"])
	uses, _ := a["tool_uses"].([]map[string]any)
	require.Len(t, uses, 1)
	assert.Equal(t, "terminal", uses[0]["name"])
	assert.Equal(t, "call_1", uses[0]["tool_use_id"])
	assert.Equal(t, "ls -la", uses[0]["command"])
	assert.Equal(t, "ls -la", uses[0]["input_summary"])

	r := got[2]
	assert.Equal(t, "tool_result", r["type"])
	assert.Equal(t, "a.go\nb.go", r["content"])
	assert.Equal(t, "terminal", r["tool_name"])
	assert.Equal(t, "call_1", r["tool_use_id"])
	assert.Equal(t, false, r["is_error"])

	assert.Equal(t, "two files", got[3]["text"])
	assert.Equal(t, "two files", got[3]["content"])
}

func TestHermesAFailingToolResultIsAnError(t *testing.T) {
	got := ParseHermesMessages(hermesRows(hermesdb.Message{ID: 1, Role: "tool", Content: `{"output":"boom","exit_code":2}`, ToolName: "terminal", ToolCallID: "c"}))
	require.Len(t, got, 1)
	assert.Equal(t, true, got[0]["is_error"])
	// a tool result that is plain text, or JSON with no output, is shown as it is
	got = ParseHermesMessages(hermesRows(hermesdb.Message{ID: 1, Role: "tool", Content: "plain words", ToolName: "x"}, hermesdb.Message{ID: 2, Role: "tool", Content: `{"other":1}`, ToolName: "x"}))
	require.Len(t, got, 2)
	assert.Equal(t, "plain words", got[0]["content"])
	assert.Equal(t, `{"other":1}`, got[1]["content"])
	assert.Equal(t, false, got[0]["is_error"])
}

func TestHermesRowsThatAreNotTurnsOrAreBrokenAreSkippedOrSoft(t *testing.T) {
	got := ParseHermesMessages(hermesRows(
		hermesdb.Message{ID: 1, Role: "system", Content: "you are..."},
		hermesdb.Message{ID: 2, Role: "user", Content: "   "},
		hermesdb.Message{ID: 3, Role: "user", Content: "<system-reminder>x</system-reminder>"},
		hermesdb.Message{ID: 4, Role: "assistant", Content: ""},
		hermesdb.Message{ID: 5, Role: "weird", Content: "x"},
		hermesdb.Message{ID: 6, Role: "assistant", Content: "text kept", ToolCalls: `not json`},
		hermesdb.Message{ID: 7, Role: "assistant", Content: "also kept", ToolCalls: `{"not":"an array"}`},
		hermesdb.Message{ID: 8, Role: "assistant", Content: "args not json", ToolCalls: `[{"id":"c","function":{"name":"terminal","arguments":"not json"}}]`},
		hermesdb.Message{ID: 9, Role: "assistant", Content: "no function", ToolCalls: `[{"id":"c"}, 5, null]`},
	))
	var texts []string
	for _, m := range got {
		texts = append(texts, m["text"].(string))
	}
	assert.Equal(t, []string{"text kept", "also kept", "args not json", "no function"}, texts)
	uses := got[2]["tool_uses"].([]map[string]any)
	require.Len(t, uses, 1)
	assert.Equal(t, "terminal", uses[0]["name"], "a call whose arguments are not JSON is still shown, by its name")
	assert.NotContains(t, uses[0], "command")
	assert.Empty(t, got[3]["tool_uses"])
	// an unset time is no time
	one := ParseHermesMessages(hermesRows(hermesdb.Message{ID: 1, Role: "user", Content: "hi"}))
	assert.Equal(t, "", one[0]["timestamp"])
}

func TestHermesTextsAreCutAtTheChatsBounds(t *testing.T) {
	got := ParseHermesMessages(hermesRows(
		hermesdb.Message{ID: 1, Role: "user", Content: strings.Repeat("u", piMaxText+500)},
		hermesdb.Message{ID: 2, Role: "tool", Content: `{"output":"` + strings.Repeat("o", 50000) + `","exit_code":0}`, ToolName: "terminal"},
	))
	require.Len(t, got, 2)
	assert.LessOrEqual(t, len(got[0]["content"].(string)), piMaxText+3)
	assert.LessOrEqual(t, len(got[1]["content"].(string)), 10100, "a tool's output is cut at 10 KB")
	assert.Contains(t, got[1]["content"], "(truncated)")
}

// Each tool call's summary is its command, path, pattern, query or url, else its name.
func TestHermesToolCallSummaries(t *testing.T) {
	call := func(name, args string) string {
		got := ParseHermesMessages(hermesRows(hermesdb.Message{ID: 1, Role: "assistant", ToolCalls: `[{"id":"c","function":{"name":"` + name + `","arguments":` + args + `}}]`}))
		require.Len(t, got, 1)
		return got[0]["tool_uses"].([]map[string]any)[0]["input_summary"].(string)
	}
	assert.Equal(t, "ls", call("terminal", `"{\"command\":\"ls\"}"`))
	assert.Equal(t, "/a/b.go", call("read_file", `"{\"path\":\"/a/b.go\"}"`))
	assert.Equal(t, "TODO", call("search_files", `"{\"pattern\":\"TODO\"}"`))
	assert.Equal(t, "cats", call("web_search", `"{\"query\":\"cats\"}"`))
	assert.Equal(t, "memory", call("memory", `"{}"`))
	assert.Equal(t, "memory", call("memory", `"{\"x\":5}"`))
}

// The tool call ids are remembered so a result with no tool name of its own is named by its call.
func TestHermesAResultWithNoToolNameTakesItFromItsCall(t *testing.T) {
	got := ParseHermesMessages(hermesRows(
		hermesdb.Message{ID: 1, Role: "assistant", ToolCalls: `[{"id":"c9","function":{"name":"read_file","arguments":"{}"}}]`},
		hermesdb.Message{ID: 2, Role: "tool", Content: "x", ToolCallID: "c9"},
	))
	require.Len(t, got, 2)
	assert.Equal(t, "read_file", got[1]["tool_name"])
}
