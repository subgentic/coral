package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #17587: Coral answers a Claude command whose pool slot is on another machine with "run": the hook writes Claude's updatedInput (the tool's whole input, its command replaced), so the agent's own command runs there.
func TestARunAnswerBecomesClaudesUpdatedInputWithTheRestOfTheInputKept(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"run":"coral-board heavy run -- 'go test ./...'"}`))
	}))
	defer srv.Close()
	in := map[string]any{"command": "go test ./...", "description": "run the tests", "timeout": 600000}
	d := map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": in}
	why, run := recordPendingToolRun(srv.URL, "dev", "sid", d, "", 0)
	if why != "" || run == "" {
		t.Fatalf("why %q run %q", why, run)
	}
	var got struct {
		Hook struct {
			Event    string         `json:"hookEventName"`
			Decision *string        `json:"permissionDecision"`
			Input    map[string]any `json:"updatedInput"`
		} `json:"hookSpecificOutput"`
	}
	out := preToolRun(d, run)
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("%s: %v", out, err)
	}
	if got.Hook.Event != "PreToolUse" || got.Hook.Decision != nil || got.Hook.Input["command"] != run || got.Hook.Input["description"] != "run the tests" || got.Hook.Input["timeout"] != float64(600000) {
		t.Errorf("output %s", out)
	}
	if strings.Contains(string(out), "permissionDecision") {
		t.Errorf("the hook must make no permission decision: %s", out)
	}
	if in["command"] != "go test ./..." {
		t.Error("the input the hook read was changed in place")
	}
	if preToolRun(map[string]any{"tool_input": map[string]any{"file_path": "x"}}, run) != nil || preToolRun(d, "") != nil || preToolRun(map[string]any{}, run) != nil {
		t.Error("an input with no command, an empty run or no input must write nothing")
	}
}

func TestARefusalWinsOverARun(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"refuse":"held","run":"coral-board heavy run -- 'x'"}`))
	}))
	defer srv.Close()
	d := map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": map[string]any{"command": "x"}}
	if why, run := recordPendingToolRun(srv.URL, "dev", "sid", d, "", 0); why != "held" || run != "" {
		t.Errorf("why %q run %q", why, run)
	}
}
