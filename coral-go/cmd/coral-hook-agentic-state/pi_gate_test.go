package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// #13647: the Pi gate. The real hook program, started as the extension starts it (--pi tool_call, the call on standard input), against a Coral that answers the pending-tool post.

const piRefusal = "Coral held this command: mac-heavy is busy and you are number 1 in line. Run: coral-board resource claim mac-heavy --wait   (it waits for your turn; then run the command again)."

func piGatePayload(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestThePiGateWritesOneRefusalLineAndNothingElse(t *testing.T) {
	call := map[string]any{"tool_name": "bash", "tool_use_id": "call-1", "command": "cd x && SECRET=hunter2 go test ./... | tail"}
	res := runFlow(t, flowRun{cli: "pi", args: []string{"--pi", "tool_call", "--hooks-rev", "1"}, stdin: piGatePayload(t, call), pretool: `{"ok":true,"refuse":"` + piRefusal + `"}`})
	if res.Stdout != `{"refuse":"`+piRefusal+`"}`+"\n" {
		t.Fatalf("stdout %q", res.Stdout)
	}
	if len(res.Requests) != 1 || !strings.HasSuffix(res.Requests[0].Path, "/pending-tool") {
		t.Fatalf("requests %+v: one pending-tool post and nothing else (no event is recorded)", res.Requests)
	}
	body, _ := res.Requests[0].Body.(map[string]any)
	if body["gate_only"] != true || body["tool_name"] != "bash" || body["tool_use_id"] != "call-1" {
		t.Errorf("post %+v", body)
	}
	if in, _ := body["tool_input"].(map[string]any); in["command"] != call["command"] {
		t.Errorf("the command goes to Coral in the post: %+v", in)
	}
	if strings.Contains(res.Stdout, "hunter2") {
		t.Errorf("the command is never written back: %q", res.Stdout)
	}
}

func TestThePiGateWritesNothingWhenTheCallRuns(t *testing.T) {
	ok := map[string]any{"tool_name": "bash", "tool_use_id": "call-1", "command": "go test ./..."}
	run := func(fields map[string]any, answer string) flowResult {
		return runFlow(t, flowRun{cli: "pi", args: []string{"--pi", "tool_call"}, stdin: piGatePayload(t, fields), pretool: answer})
	}
	refusal := `{"ok":true,"refuse":"` + piRefusal + `"}`
	for name, c := range map[string]struct {
		fields map[string]any
		answer string
	}{
		"Coral answers ok":               {ok, `{"ok":true}`},
		"Coral answers an error":         {ok, `{"error":"session_token_required"}`},
		"Coral answers not JSON":         {ok, `not json`},
		"a refusal without the opener":   {ok, `{"ok":true,"refuse":"Run something else"}`},
		"a refusal that is not ASCII":    {ok, `{"ok":true,"refuse":"Coral held this command: café"}`},
		"a refusal that is too long":     {ok, `{"ok":true,"refuse":"Coral held this command: ` + strings.Repeat("x", 400) + `"}`},
		"another tool":                   {map[string]any{"tool_name": "read", "tool_use_id": "c", "command": "go test ./..."}, refusal},
		"an unsafe call id":              {map[string]any{"tool_name": "bash", "tool_use_id": "a b;rm", "command": "go test ./..."}, refusal},
		"no command":                     {map[string]any{"tool_name": "bash", "tool_use_id": "c"}, refusal},
		"a command over the bound":       {map[string]any{"tool_name": "bash", "tool_use_id": "c", "command": strings.Repeat("x", 16385)}, refusal},
		"a command that is not a string": {map[string]any{"tool_name": "bash", "tool_use_id": "c", "command": []string{"go", "test"}}, refusal},
	} {
		if res := run(c.fields, c.answer); res.Stdout != "" {
			t.Errorf("%s: wrote %q, the call must run", name, res.Stdout)
		}
	}
	// the over-bound and the unsafe cases never reach Coral at all
	if res := run(map[string]any{"tool_name": "bash", "tool_use_id": "c", "command": strings.Repeat("x", 16385)}, refusal); len(res.Requests) != 0 {
		t.Errorf("an over-long command was sent to Coral: %+v", res.Requests)
	}
}

// Another extension event is untouched by the gate: the hook records it as before, and a refusal in Coral's answer does not turn it into a deny or a line on standard output.
func TestAPiNotificationEventNeverWritesARefusal(t *testing.T) {
	res := runFlow(t, flowRun{cli: "pi", args: []string{"--pi", "tool_execution_start"}, stdin: piGatePayload(t, map[string]any{"tool_name": "bash", "tool_use_id": "c1"}), pretool: `{"ok":true,"refuse":"` + piRefusal + `"}`})
	if strings.Contains(res.Stdout, "refuse") || strings.Contains(res.Stdout, "permissionDecision") {
		t.Errorf("a notification event wrote %q", res.Stdout)
	}
}
