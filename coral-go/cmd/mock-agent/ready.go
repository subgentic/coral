package main

// Ready mode (MOCK_AGENT_READY=1, #10010): the mock behaves like a CLI that is up and waiting for its first message, so a person trying Coral with it gets what a real agent gives: the input box on
// its screen (a send is typed into it), the first hook event (SessionStart, so the row is not "starting"), and a short canned reply in its transcript for every message (so the chat shows it).
// It is the raw-input mode's box and hooks (a folder of its own when MOCK_AGENT_RAW_DIR is not set), the transcript, and the idle profile (no heartbeat output, no turn of its own), switched on by one
// variable. The hooks run only where Coral's hooks are installed (a dev or test server needs CORAL_HOOK_DIR pointing at the built coral-hook-* programs). Off by default: every other suite reads the heartbeat mock.

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// exitNow ends the process; a test replaces it.
var exitNow = os.Exit

// readyMode is whether MOCK_AGENT_READY=1.
func readyMode() bool { return os.Getenv("MOCK_AGENT_READY") == "1" }

// underTemp is whether path is inside a temp folder (the OS's, or /tmp and /var/tmp), after symlinks: a test's own HOME, never a person's.
func underTemp(path string) bool {
	resolve := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return filepath.Clean(p)
	}
	p := resolve(path)
	for _, t := range []string{os.TempDir(), "/tmp", "/var/tmp"} {
		root := resolve(t)
		if p == root || strings.HasPrefix(p, root+string(filepath.Separator)) {
			return p != root // the temp folder itself is not a home
		}
	}
	return false
}

// readyTranscriptSafe is whether the ready mode's transcript can only land in a test's own folder: CLAUDE_PROJECTS_DIR is set, or HOME is under a temp folder. Otherwise the transcript would go to the
// real ~/.claude/projects, where Claude Code's own sessions are (#10033).
func readyTranscriptSafe() bool {
	if os.Getenv("CLAUDE_PROJECTS_DIR") != "" {
		return true
	}
	home, err := os.UserHomeDir()
	return err == nil && home != "" && underTemp(home)
}

// applyReadyMode sets the environment the other modes read, for ready mode, and says whether the transcript is written. A setting the caller made wins (MOCK_AGENT_RAW_DIR, MOCK_AGENT_IDLE). The
// transcript is written only where it cannot reach a real ~/.claude/projects (readyTranscriptSafe); otherwise ready mode says why on stderr and goes on without it.
func applyReadyMode(writeTranscript bool) bool {
	if !readyMode() {
		return writeTranscript
	}
	if os.Getenv("MOCK_AGENT_RAW_DIR") == "" {
		if dir, err := os.MkdirTemp("", "mock-agent-ready-"); err == nil { // one of its own per agent, owner-only
			os.Setenv("MOCK_AGENT_RAW_DIR", dir)
		}
	}
	if os.Getenv("MOCK_AGENT_IDLE") == "" {
		os.Setenv("MOCK_AGENT_IDLE", "1")
	}
	if !readyTranscriptSafe() {
		fmt.Fprintln(os.Stderr, "[mock-agent] ready mode: no transcript is written: HOME is not under a temp folder and CLAUDE_PROJECTS_DIR is not set, so it would go to the real ~/.claude/projects. Start the server with its own HOME under /tmp, or set CLAUDE_PROJECTS_DIR.")
		return writeTranscript
	}
	return true
}

// readyReply is the canned answer to a message in ready mode.
func readyReply(prompt string) string {
	return "Hi! I'm mock-agent, a stand-in for a real agent, so this reply is canned. You said: " + firstLine(prompt)
}

// questionMenu is drawn like Claude Code's AskUserQuestion, as Coral's PromptOnScreen reads a menu.
const questionMenu = "\r\n Pick a color:\r\n \u276f 1. Red\r\n   2. Blue\r\n\r\n Enter to select \u00b7 Esc to cancel\r\n"

// applyControl handles the lines a tester types to make the mock do something on demand (#10168), whatever mode it is in; it reports whether the line was one:
//
//	MOCK_ASK_PERMISSION  a permission menu opens and the PermissionRequest and Notification hooks fire: a Needs you row ("permission")
//	MOCK_ASK_QUESTION    a question opens ("Pick a color:", Red or Blue) with the AskUserQuestion permission request: a Needs you row ("question")
//	MOCK_GO_DEAF         the mock stops reading: its box stays on screen but takes nothing and it answers nothing: a send is accepted and no reply ever comes (the chat stays blank)
//	MOCK_STUCK_ENTER     the box takes text but an Enter does not submit it: the next send is refused (a message not submitted, then "an earlier message is still in the box"): the send-error box
//	MOCK_BUSY [seconds]  the turn stays open (30 s without a number): the agent is working and sends no Stop until then, so a tester can reach Stop and queue sends (#10602)
//	MOCK_EXIT            the mock ends at once, as a CLI that quit: the agent is over, and the next send is refused (the send-error box)
//
// An Enter answers an open menu (option 1) and an Escape dismisses it; both fire the hooks that end the wait. waiting says a menu is open: the line's UserPromptSubmit is sent (so Coral confirms the send) but not its Stop.
func applyControl(box *inputBox, line string) (handled, waiting bool) {
	if line == "MOCK_BUSY" || strings.HasPrefix(line, "MOCK_BUSY ") {
		secs := 30.0
		if f := strings.Fields(line); len(f) > 1 {
			n, err := strconv.ParseFloat(f[1], 64)
			if err != nil || n <= 0 || len(f) > 2 {
				return false, false
			}
			secs = n
		}
		box.busyFor = time.Duration(secs * float64(time.Second))
		fmt.Printf("\r\n[mock-agent] working for %gs\r\n", secs)
		return true, true
	}
	switch line {
	case "MOCK_ASK_PERMISSION":
		box.promptOpen, box.question = true, false
		drawBox(box)
		fmt.Print(promptMenu)
		box.tell("permission_request")
		return true, true
	case "MOCK_ASK_QUESTION":
		box.promptOpen, box.question = true, true
		drawBox(box)
		fmt.Print(questionMenu)
		box.tell("question_request")
		return true, true
	case "MOCK_STUCK_ENTER":
		box.noSubmit = true
		fmt.Print("\r\n[mock-agent] Enter no longer submits\r\n")
		return true, false
	case "MOCK_EXIT":
		fmt.Print("\r\n[mock-agent] exiting on request\r\n")
		time.Sleep(300 * time.Millisecond) // the line's UserPromptSubmit hook is on its way: let it go first
		exitNow(0)
		return true, false
	case "MOCK_GO_DEAF":
		fmt.Print("\r\n[mock-agent] not reading input any more\r\n")
		box.deaf = true
		return true, false
	}
	return false, false
}
