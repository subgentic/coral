package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
)

// MOCK_AGENT_MODELS=1 (#13180): the mock answers Coral's model query the way Claude Code does. Coral starts the CLI with
// "-p --input-format stream-json --output-format stream-json --verbose" and writes one initialize control request; the CLI
// answers one control_response that lists its models. With the variable unset the mock treats that call as it always did
// (a one-shot print), so no suite changes.
func modelsQueryEnabled() bool { return os.Getenv("MOCK_AGENT_MODELS") == "1" }

// isStreamJSONCall reports whether args are the model query's: print mode with the stream-json input format.
func isStreamJSONCall(args []string) bool {
	var print, stream bool
	for i, a := range args {
		if a == "-p" || a == "--print" {
			print = true
		}
		if a == "stream-json" && i > 0 && args[i-1] == "--input-format" {
			stream = true
		}
	}
	return print && stream
}

// mockModels is the list the reply carries: the five names Coral's picker shows for Claude Code.
func mockModels() []map[string]any {
	efforts := []string{"low", "medium", "high", "xhigh", "max"}
	m := func(value, resolved, name, desc string) map[string]any {
		return map[string]any{"value": value, "resolvedModel": resolved, "displayName": name, "description": desc, "supportsEffort": true, "supportedEffortLevels": efforts}
	}
	return []map[string]any{
		m("default", "claude-opus-5-5", "Default (recommended)", "Opus 5.5 · Best for everyday, complex tasks"),
		m("fable", "claude-fable-5-1", "Fable 5.1", "The most capable model for hard problems"),
		m("opus", "claude-opus-5-5", "Opus 5.5", "For complex work and everyday tasks"),
		m("sonnet", "claude-sonnet-5-5", "Sonnet 5.5", "Fast and capable for daily coding"),
		m("haiku", "claude-haiku-5-5", "Haiku 5.5", "Fastest for quick answers"),
	}
}

// answerModelsQuery reads control requests from in and answers each initialize with the model list, until in ends.
func answerModelsQuery(in io.Reader, out io.Writer) {
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, []byte(`"control_request"`)) {
			continue
		}
		var req struct {
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype string `json:"subtype"`
			} `json:"request"`
		}
		if json.Unmarshal(line, &req) != nil || !strings.EqualFold(req.Request.Subtype, "initialize") {
			continue
		}
		reply := map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "success", "request_id": req.RequestID,
			"response": map[string]any{"commands": []any{}, "models": mockModels()},
		}}
		b, _ := json.Marshal(reply)
		out.Write(append(b, '\n'))
	}
}
