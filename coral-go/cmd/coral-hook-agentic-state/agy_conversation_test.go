package main

import (
	"encoding/json"
	"github.com/subgentic/coral/internal/testguard"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// #7764: every payload of a real agy 1.4.7 (captured by the Antigravity CLI tester) names the conversation the transcript is kept under.
func TestAgyConversationOfIsThePayloadsConversationId(t *testing.T) {
	const want = "fecb5db1-d9d6-41b4-9988-5511a652edbf"
	files, err := filepath.Glob(filepath.Join("testdata", "agy-1.4.7", "*.json"))
	if err != nil || len(files) != 8 {
		t.Fatalf("the capture: %v %v", files, err)
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var d map[string]any
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatal(err)
		}
		if got := agyConversationOf(d, "SessionStart"); got != want {
			t.Errorf("%s: %q", filepath.Base(f), got)
		}
		if got := agyConversationOf(d, ""); got != "" {
			t.Errorf("%s: another agent's payload names no agy conversation: %q", filepath.Base(f), got)
		}
	}
	if got := agyConversationOf(map[string]any{}, "SessionStart"); got != "" {
		t.Errorf("a payload without one: %q", got)
	}
}

// TestAgyHookHelperProcess is the hook itself, run as a child of the test below (never on its own).
func TestAgyHookHelperProcess(t *testing.T) {
	if os.Getenv("CORAL_AGY_HOOK_HELPER") != "1" {
		t.Skip("not the helper process")
	}
	os.Args = []string{"coral-hook-agentic-state", "--agy", "SessionStart"}
	main()
}

// #7764: the hook, given a real agy 1.4.7 SessionStart, binds the Coral session to agy's conversation, so chat, history search and token usage find the transcript. Run as the hook is run: a
// child process with the payload on its stdin, an isolated home and agy data folder, and no Coral server to answer.
func TestAgyHookBindsTheSessionToItsConversation(t *testing.T) {
	const session = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	home := t.TempDir()
	agyData := filepath.Join(home, "agy")
	if err := os.MkdirAll(filepath.Join(agyData, "brain"), 0o700); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) })) // what the hook posts goes nowhere
	defer srv.Close()
	payload, err := os.Open(filepath.Join("testdata", "agy-1.4.7", "SessionStart-0.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer payload.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestAgyHookHelperProcess$")
	cmd.Stdin = payload
	cmd.Env = []string{
		"CORAL_AGY_HOOK_HELPER=1", "TESTGUARD_AGENT_ENV_SCRUBBED=1", // the child keeps the CORAL_* values this test gives it
		"HOME=" + home, "USERPROFILE=" + home, "ANTIGRAVITY_DATA_DIR=" + agyData, "CORAL_DATA_DIR=" + filepath.Join(home, "coral"),
		"CORAL_SESSION_ID=" + session, "CORAL_SESSION_NAME=agy-" + session, "CORAL_URL=" + srv.URL, testguard.TestURLEnv + "=1", "PATH=" + os.Getenv("PATH"),
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("the hook: %v\n%s", err, out)
	}
	b, err := os.ReadFile(filepath.Join(agyData, "coral-session-links", session+".json"))
	if err != nil {
		t.Fatalf("no link written: %v", err)
	}
	if string(b) != `{"conversation_id":"fecb5db1-d9d6-41b4-9988-5511a652edbf"}` {
		t.Errorf("the link: %s", b)
	}
}
