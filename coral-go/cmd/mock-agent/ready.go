package main

// Ready mode (MOCK_AGENT_READY=1, #10010): the mock behaves like a CLI that is up and waiting for its first message, so a person trying Coral with it gets what a real agent gives: the input box on
// its screen (a send is typed into it), the first hook event (SessionStart, so the row is not "starting"), and a short canned reply in its transcript for every message (so the chat shows it).
// It is the raw-input mode's box and hooks (a folder of its own when MOCK_AGENT_RAW_DIR is not set), the transcript, and the idle profile (no heartbeat output, no turn of its own), switched on by one
// variable. The hooks run only where Coral's hooks are installed (a dev or test server needs CORAL_HOOK_DIR pointing at the built coral-hook-* programs). Off by default: every other suite reads the heartbeat mock.

import (
	"os"
	"path/filepath"
)

// readyMode is whether MOCK_AGENT_READY=1.
func readyMode() bool { return os.Getenv("MOCK_AGENT_READY") == "1" }

// applyReadyMode sets the environment the other modes read, for ready mode, and says whether the transcript is written. A setting the caller made wins (MOCK_AGENT_RAW_DIR, MOCK_AGENT_IDLE).
func applyReadyMode(writeTranscript bool) bool {
	if !readyMode() {
		return writeTranscript
	}
	if os.Getenv("MOCK_AGENT_RAW_DIR") == "" {
		dir := filepath.Join(os.TempDir(), "mock-agent-ready")
		if os.MkdirAll(dir, 0o700) == nil {
			os.Setenv("MOCK_AGENT_RAW_DIR", dir)
		}
	}
	if os.Getenv("MOCK_AGENT_IDLE") == "" {
		os.Setenv("MOCK_AGENT_IDLE", "1")
	}
	return true
}

// readyReply is the canned answer to a message in ready mode.
func readyReply(prompt string) string {
	return "Hi! I'm mock-agent, a stand-in for a real agent, so this reply is canned. You said: " + firstLine(prompt)
}
