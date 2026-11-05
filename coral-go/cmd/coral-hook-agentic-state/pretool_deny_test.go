package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// #11157: Coral answers the PreToolUse post of a command that stops processes by a pattern with the reason; the hook turns it into Claude's refusal (permissionDecision deny), and a post
// that says nothing, or fails, lets the tool run.
func TestAPatternKillRefusalBecomesClaudesDeny(t *testing.T) {
	answer := `{"ok":true,"refuse":"Coral refused this command: pkill stops processes by a name or a pattern. Stop only what you started."}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/sessions/live/dev/pending-tool" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(answer))
	}))
	defer srv.Close()

	d := map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": map[string]any{"command": "pkill -f x"}}
	why := recordPendingTool(srv.URL, "dev", "sid", d, "", 0)
	if why == "" {
		t.Fatal("the refusal was not read")
	}
	var got struct {
		Hook struct {
			Event    string `json:"hookEventName"`
			Decision string `json:"permissionDecision"`
			Reason   string `json:"permissionDecisionReason"`
		} `json:"hookSpecificOutput"`
	}
	out := preToolDeny(why)
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("%s: %v", out, err)
	}
	if got.Hook.Event != "PreToolUse" || got.Hook.Decision != "deny" || got.Hook.Reason != why {
		t.Errorf("output %s", out)
	}

	answer = `{"ok":true}`
	if why := recordPendingTool(srv.URL, "dev", "sid", d, "", 0); why != "" {
		t.Errorf("nothing refused: %q", why)
	}
	answer = `{"error":"session_token_required"}`
	if why := recordPendingTool(srv.URL, "dev", "sid", d, "", 0); why != "" {
		t.Errorf("an error is not a refusal: %q", why)
	}
	if why := recordPendingTool("http://127.0.0.1:1", "dev", "sid", d, "", 0); why != "" {
		t.Errorf("Coral unreachable: the tool runs: %q", why)
	}
}

// #13647: a Coral refusal is written as the CLI's PreToolUse answer for a Claude or a Codex session, and never for an agy hook or another CLI, whose command runs.
func TestARefusalIsWrittenForClaudeAndCodexSessionsOnly(t *testing.T) {
	for _, c := range []struct {
		agy, session string
		want         bool
	}{
		{"", "claude-1111", true},
		{"", "codex-2222", true},
		{"", "gemini-3333", false},
		{"", "pi-4444", false},
		{"", "", false},
		{"PreToolUse", "claude-1111", false},
		{"PreToolUse", "codex-2222", false},
	} {
		if got := refusalApplies(c.agy, c.session); got != c.want {
			t.Errorf("refusalApplies(%q, %q) = %v, want %v", c.agy, c.session, got, c.want)
		}
	}
}

// #13647, at the hook wire: the real hook program, run as a Claude, a Codex and another CLI's session against a Coral that answers the pending-tool post with a refusal. A Claude and a Codex session get
// Claude's PreToolUse deny (hookSpecificOutput.permissionDecision, which Codex's PreToolUse takes in the same words) with Coral's reason; another CLI gets nothing and its command runs; a Coral that answers
// nothing, or something else, refuses nothing.
func TestTheHookProgramWritesTheDenyForCodexAsForClaude(t *testing.T) {
	const reason = "Coral held this command: mac-heavy is busy and you are number 1 in line."
	refusal := `{"ok":true,"refuse":"` + reason + `"}`
	payload := func(cli string) []byte {
		return flowPayload(t, map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "call_1", "tool_input": map[string]any{"command": "go test ./..."}})
	}
	for _, cli := range []string{"claude", "codex"} {
		out := runFlow(t, flowRun{cli: cli, stdin: payload(cli), pretool: refusal}).Stdout
		var got struct {
			Hook struct {
				Event    string `json:"hookEventName"`
				Decision string `json:"permissionDecision"`
				Reason   string `json:"permissionDecisionReason"`
			} `json:"hookSpecificOutput"`
		}
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("%s: %q: %v", cli, out, err)
		}
		if got.Hook.Event != "PreToolUse" || got.Hook.Decision != "deny" || got.Hook.Reason != reason {
			t.Errorf("%s: output %q", cli, out)
		}
	}
	for _, c := range []struct{ cli, answer string }{
		{"gemini", refusal}, {"pi", refusal}, // another CLI's command runs
		{"codex", `{"ok":true}`}, {"codex", `{"error":"session_token_required"}`}, {"codex", `not json`}, // nothing refused
	} {
		if out := runFlow(t, flowRun{cli: c.cli, stdin: payload(c.cli), pretool: c.answer}).Stdout; out != "" {
			t.Errorf("%s with %q wrote %q: the command must run", c.cli, c.answer, out)
		}
	}
}
