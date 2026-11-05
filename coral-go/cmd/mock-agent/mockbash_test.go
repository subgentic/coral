package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMockBashLineIsParsed(t *testing.T) {
	for line, want := range map[string][2]string{
		"MOCK_BASH wait sleep 3":        {"wait", "sleep 3"},
		"MOCK_BASH nowait nohup x &":    {"nowait", "nohup x &"},
		"MOCK_BASH   wait   go test ./": {"wait", "go test ./"},
	} {
		mode, command, ok := parseMockBash(line)
		if !ok || mode != want[0] || command != want[1] {
			t.Errorf("%q: %q %q %v", line, mode, command, ok)
		}
	}
	for _, bad := range []string{"MOCK_BASH", "MOCK_BASH wait", "MOCK_BASH later ls", "MOCK_BASHwait ls", "ls", ""} {
		if _, _, ok := parseMockBash(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

// The hook command in these tests is the test binary itself (see TestHookHelperProcess), not a shell script: the same fixture on every system, Windows included.
func TestHookHelperProcess(t *testing.T) {
	if os.Getenv("MOCK_BASH_HELPER") != "1" {
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	fmt.Print(os.Getenv("MOCK_BASH_HELPER_OUT"))
	os.Exit(0)
}

func mockHookRunner(t *testing.T, dir, name, hookOut string) *hookRunner {
	t.Helper()
	t.Setenv("MOCK_BASH_HELPER", "1")
	t.Setenv("MOCK_BASH_HELPER_OUT", hookOut)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{"hooks": map[string]any{"PreToolUse": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": `"` + exe + `" -test.run=TestHookHelperProcess`}}}}}}
	b, _ := json.Marshal(settings)
	path := filepath.Join(dir, name+".json")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return newHookRunner(path, "sid")
}

// A PreToolUse hook that denies the call ends it there; one that does not lets the command really run.
func TestMockBashStopsWhenTheHookDeniesAndRunsWhenItDoesNot(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran")
	const denyOut = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"busy: number 2"}}`
	deny := mockHookRunner(t, dir, "deny", denyOut)
	if r := deny.fireResult("PreToolUse", nil); r != "busy: number 2" {
		t.Fatalf("denial reason: %q", r)
	}
	runMockBash(deny, "a", "wait", "touch "+marker, nil)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a denied command ran")
	}
	allow := mockHookRunner(t, dir, "allow", "")
	if r := allow.fireResult("PreToolUse", nil); r != "" {
		t.Fatalf("a hook that says nothing denied: %q", r)
	}
	if runtime.GOOS == "windows" {
		return // the allowed command is run by `sh -c` (a POSIX shell, which the runner's PATH may not have): the stand-in is a Unix test tool, the denial path above is the same everywhere
	}
	runMockBash(allow, "a", "wait", "touch "+marker, nil)
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("an allowed command did not run")
	}
}
