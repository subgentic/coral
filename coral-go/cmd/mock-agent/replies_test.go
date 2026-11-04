package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func scriptFile(t *testing.T, body string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "replies.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOCK_AGENT_REPLIES", p)
}

func transcriptText(t *testing.T, tr *transcript) string {
	t.Helper()
	b, err := os.ReadFile(tr.path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

const scriptSID = "00000000-0000-4000-8000-00000000b13a"

// MOCK_AGENT_REPLIES (#13180): a keyword entry answers the prompt that contains it, with its tool step; unkeyed entries
// answer the other prompts in order.
func TestScriptedRepliesByKeywordAndOrder(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	scriptFile(t, `[
	  {"when":"Wind Chill","text":"Added FeelsLike and a test.","tool":{"name":"Bash","command":"go test ./...","output":"ok  skyline 0.4s"}},
	  {"text":"First unkeyed answer."},
	  {"text":"Second unkeyed answer."}
	]`)
	tr := newTranscript(scriptSID, "")
	for _, p := range []string{"hello", "please add the wind chill change", "and now?", "last one"} {
		if err := tr.Turn(p); err != nil {
			t.Fatal(err)
		}
	}
	out := transcriptText(t, tr)
	for _, want := range []string{"First unkeyed answer.", "Added FeelsLike and a test.", "Second unkeyed answer.", "go test ./...", "ok  skyline 0.4s"} {
		if !strings.Contains(out, want) {
			t.Errorf("transcript lacks %q", want)
		}
	}
	// the turn after the script runs out answers as the mock always did
	if !strings.Contains(out, "Mock reply 4 to: last one") {
		t.Errorf("an exhausted script must fall back to the numbered line: %s", out)
	}
	// tool steps: the scripted one (turn 2) and the default ls the fallback turn 4 gets as ever; the unkeyed entries add none
	if n := strings.Count(out, `"type":"tool_use"`); n != 2 {
		t.Errorf("want 2 tool uses (the scripted one and the default one on turn 4), got %d", n)
	}
}

// With the variable unset, an unreadable file or bad JSON the answers are the old ones: the mock's default must not change.
func TestScriptedRepliesDefaultUnchanged(t *testing.T) {
	for name, set := range map[string]func(){
		"unset":   func() { t.Setenv("MOCK_AGENT_REPLIES", "") },
		"missing": func() { t.Setenv("MOCK_AGENT_REPLIES", filepath.Join(t.TempDir(), "nope.json")) },
		"bad":     func() { scriptFile(t, `{"not":"an array"`) },
		"empty":   func() { scriptFile(t, `[{"text":"  "}]`) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
			set()
			tr := newTranscript(scriptSID, "")
			if err := tr.Turn("first prompt"); err != nil {
				t.Fatal(err)
			}
			if err := tr.Turn("second prompt"); err != nil {
				t.Fatal(err)
			}
			out := transcriptText(t, tr)
			if !strings.Contains(out, "Mock reply 1 to: first prompt") || !strings.Contains(out, "Mock reply 2 to: second prompt") {
				t.Errorf("default answers changed: %s", out)
			}
			if strings.Count(out, `"type":"tool_use"`) != 1 { // every other turn: turn 2 only
				t.Errorf("default tool step changed: %d", strings.Count(out, `"type":"tool_use"`))
			}
		})
	}
}
