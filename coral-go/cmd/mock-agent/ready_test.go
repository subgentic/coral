package main

import (
	"os"
	"strings"
	"testing"
)

// Ready mode (#10010) is one switch for what a person trying Coral with the mock needs: the raw-input box and hooks (a folder of its own), the idle profile, and the transcript. Off, nothing changes.
func TestReadyModeSetsWhatTheOtherModesRead(t *testing.T) {
	t.Run("off: nothing is set and the transcript choice is the caller's", func(t *testing.T) {
		t.Setenv("MOCK_AGENT_READY", "")
		t.Setenv("MOCK_AGENT_RAW_DIR", "")
		t.Setenv("MOCK_AGENT_IDLE", "")
		if applyReadyMode(false) {
			t.Error("the transcript was turned on")
		}
		if os.Getenv("MOCK_AGENT_RAW_DIR") != "" || os.Getenv("MOCK_AGENT_IDLE") != "" {
			t.Error("the environment was changed")
		}
	})
	t.Run("on: the box and hooks, idle, and the transcript", func(t *testing.T) {
		t.Setenv("TMPDIR", t.TempDir())
		t.Setenv("MOCK_AGENT_READY", "1")
		t.Setenv("MOCK_AGENT_RAW_DIR", "")
		t.Setenv("MOCK_AGENT_IDLE", "")
		if !applyReadyMode(false) {
			t.Error("the transcript is not written")
		}
		if dir := rawInputDir(); dir == "" || !strings.HasPrefix(dir, os.TempDir()) {
			t.Errorf("raw-input mode is not on, in a folder of its own: %q", dir)
		}
		if os.Getenv("MOCK_AGENT_IDLE") != "1" {
			t.Error("the idle profile is not on")
		}
	})
	t.Run("on: a folder the caller set is kept", func(t *testing.T) {
		own := t.TempDir()
		t.Setenv("MOCK_AGENT_READY", "1")
		t.Setenv("MOCK_AGENT_RAW_DIR", own)
		applyReadyMode(false)
		if rawInputDir() != own {
			t.Errorf("raw folder %q, want %q", rawInputDir(), own)
		}
	})
}

// The reply a person sees in the chat is the canned greeting naming what they said, not the numbered line the suites read; with it off the numbered line is unchanged.
func TestReadyModeRepliesWithAGreeting(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	read := func(sid string) string {
		tr := newTranscript(sid, "claude-sonnet-5-5")
		if tr == nil {
			t.Fatal("no transcript")
		}
		if err := tr.Turn("hello, what can you do?\nsecond line"); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(tr.path)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	t.Setenv("MOCK_AGENT_READY", "1")
	got := read("00000000-0000-4000-8000-00000000a0d1")
	if want := "Hi! I'm mock-agent, a stand-in for a real agent, so this reply is canned. You said: hello, what can you do?"; !strings.Contains(got, want) {
		t.Errorf("ready reply %q, want it to contain %q", got, want)
	}
	t.Setenv("MOCK_AGENT_READY", "")
	if got := read("00000000-0000-4000-8000-00000000a0d2"); !strings.Contains(got, "Mock reply 1 to: hello, what can you do?") {
		t.Errorf("default reply changed: %q", got)
	}
}
