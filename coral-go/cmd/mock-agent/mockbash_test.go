package main

import (
	"os"
	"path/filepath"
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

// A PreToolUse hook that denies the call ends it there; one that does not lets the command really run.
func TestMockBashStopsWhenTheHookDeniesAndRunsWhenItDoesNot(t *testing.T) {
	dir := t.TempDir()
	mk := func(name, hookOut string) *hookRunner {
		script := filepath.Join(dir, name+".sh")
		os.WriteFile(script, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s' '"+hookOut+"'\n"), 0o755)
		settings := filepath.Join(dir, name+".json")
		os.WriteFile(settings, []byte(`{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"`+script+`"}]}]}}`), 0o644)
		return newHookRunner(settings, "sid")
	}
	marker := filepath.Join(dir, "ran")
	deny := mk("deny", `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"busy: number 2"}}`)
	runMockBash(deny, "a", "wait", "touch "+marker)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a denied command ran")
	}
	allow := mk("allow", "")
	runMockBash(allow, "a", "wait", "touch "+marker)
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("an allowed command did not run")
	}
	if r := deny.fireResult("PreToolUse", nil); r != "busy: number 2" {
		t.Errorf("denial reason: %q", r)
	}
}
