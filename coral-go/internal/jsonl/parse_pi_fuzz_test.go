package jsonl

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// FuzzParsePiEntry (#11088): a Pi session file is written by an agent CLI, and what the model and its tools printed ends up inside it. Any line, however shaped, never panics the parser and
// gives only messages of the chat's kinds, with text that is valid and bounded, and tool calls with a string name and id. Seeds are the recorded session under testdata/pi-1.4.0 and the odd shapes below.
// go test -fuzz FuzzParsePiEntry -fuzztime 10m ./internal/jsonl/ fuzzes.
func FuzzParsePiEntry(f *testing.F) {
	transcriptSeeds(f)
	for _, s := range []string{
		`{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":1,"name":2,"arguments":"x"},{"type":"text","text":5},{"type":"thinking"}]}}`,
		`{"type":"message","message":{"role":"toolResult","toolCallId":null,"content":{"a":1},"isError":"yes"}}`,
		`{"type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"` + strings.Repeat("é", 5000) + `"}}`,
		`{"type":"message","message":{"role":"user","content":[{"type":"image","data":"AAAA","mimeType":"image/png"},{"type":"text","text":"hi"}]}}`,
		`{"type":"message","message":{"role":"bashExecution","command":"ls","output":"x","exitCode":0}}`,
		`{"type":"custom_message","display":true,"content":[{"type":"text","text":"note"}]}`,
		`{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"edit","arguments":{"edits":[1,{"oldText":"a","newText":"b"}]}}]}}`,
		`{"type":"message","message":{"role":"assistant","content":"plain string"}}`,
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, line []byte) {
		var entry map[string]any
		if json.Unmarshal(line, &entry) != nil {
			return
		}
		names := map[string]string{}
		for _, m := range parsePiEntry(entry, names) {
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
					if len(s) > 4*10000+64 {
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
