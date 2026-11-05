package main

// MOCK_BASH <wait|nowait> <command...> (resource queue hook, #13645): the mock runs a Bash tool call the way Claude Code does. It fires the PreToolUse hook with the command (so Coral's server sees it and
// may hold it); a hook that denies the call ends it there ("REFUSED", the reason on the terminal); otherwise the command really runs as a child of the mock (sh -c), PostToolUse fires when it ends
// ("wait") or at once ("nowait": the call returns while its work, such as a script that forks a suite, keeps running), and the terminal says RUNNING and DONE. Typed into a mock in raw-input mode.

import (
	"fmt"
	"os/exec"
	"strings"
	"sync/atomic"
)

var mockBashSeq atomic.Int64

// parseMockBash reads the typed line; ok is false when it is not one.
func parseMockBash(line string) (mode, command string, ok bool) {
	rest, found := strings.CutPrefix(line, "MOCK_BASH ")
	if !found {
		return "", "", false
	}
	mode, command, found = strings.Cut(strings.TrimSpace(rest), " ")
	command = strings.TrimSpace(command)
	if !found || command == "" || (mode != "wait" && mode != "nowait") {
		return "", "", false
	}
	return mode, command, true
}

// runMockBash is one such call.
func runMockBash(h *hookRunner, name, mode, command string, redraw func()) {
	defer func() { // the turn ends after the call, as Claude Code's does: Coral holds typed input while a turn runs, so without the Stop the next line would wait forever
		if redraw != nil {
			redraw() // an empty input box again: Coral will not type into a box that still shows a line
		}
		h.fire("Stop", map[string]any{"stop_hook_active": false})
	}()
	id := fmt.Sprintf("toolu_mockbash_%s_%d", name, mockBashSeq.Add(1))
	if reason := h.fireResult("PreToolUse", map[string]any{"tool_name": "Bash", "tool_use_id": id, "tool_input": map[string]any{"command": command}}); reason != "" {
		sayf("\r\n[mock-agent] bash REFUSED: %s\r\n", strings.Join(strings.Fields(reason), " "))
		return
	}
	cmd := exec.Command("sh", "-c", command)
	cmd.Stdout, cmd.Stderr = nil, nil
	if err := cmd.Start(); err != nil {
		sayErrf("[mock-agent] bash could not start: %v\r\n", err)
		h.fire("PostToolUse", map[string]any{"tool_name": "Bash", "tool_use_id": id, "tool_response": map[string]any{"stdout": ""}})
		return
	}
	sayf("\r\n[mock-agent] bash RUNNING: %s\r\n", command)
	done := func() {
		h.fire("PostToolUse", map[string]any{"tool_name": "Bash", "tool_use_id": id, "tool_response": map[string]any{"stdout": ""}})
		sayf("\r\n[mock-agent] bash DONE (%s): %s\r\n", mode, command)
	}
	if mode == "nowait" {
		go func() { _ = cmd.Wait() }() // the work goes on; the call itself returns at once
		done()
		return
	}
	_ = cmd.Wait()
	done()
}
