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
