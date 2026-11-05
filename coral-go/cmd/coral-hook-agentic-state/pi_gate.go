package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/hooks"
)

// The resource queue's gate for Pi (#13647): `coral-hook-agentic-state --pi tool_call`, started by Coral's Pi extension before a bash call runs, with the call's id and command line on its standard input as JSON.
// It asks Coral whether the call must wait for a slot of a shared machine (the pending-tool post with gate_only, which records nothing about the call) and writes ONE line of JSON to its standard output, and nothing
// else, for the extension to read:
//
//	{"refuse":"<Coral's fixed text>"}   when Coral held the call (the text names the resource and the place in line, never the command)
//
// Nothing at all in any other case (no answer, an error, a text that is not printable ASCII on one line, or a payload that is not a bash call): the call runs. The command is read from the payload, sent to Coral
// in the one post and never logged or written back.

const (
	piGateCommandMax = 16 << 10 // the longest command asked about; the extension's CMD_MAX
	piGateRefuseMax  = 400      // the longest refusal passed on; the extension's REFUSE_MAX
	piGateOpener     = "Coral held this command: "
)

var piGateText = regexp.MustCompile(`^[\x20-\x7e]+$`)

// runPiGate reads the extension's payload d and writes the refusal line, if any, to os.Stdout.
func runPiGate(d map[string]any) {
	if line := piGateAnswer(d, func(agent, sessionID string, post map[string]any) ([]byte, error) {
		return hooks.CoralAPI(hooks.CoralBase(), "POST", hooks.LivePath(agent, "/pending-tool"), post)
	}); line != nil {
		os.Stdout.Write(append(line, '\n'))
		hooks.DebugLog("PI_GATE_REFUSED") // never the command
	}
}

// piGateAnswer is the line to write for payload d (nil: write nothing). ask sends the post to Coral and returns its answer.
func piGateAnswer(d map[string]any, ask func(agent, sessionID string, post map[string]any) ([]byte, error)) []byte {
	if tool, _ := d["tool_name"].(string); tool != "bash" {
		return nil
	}
	id, _ := d["tool_use_id"].(string)
	command, _ := d["command"].(string)
	if !piSafeID.MatchString(id) || command == "" || len(command) > piGateCommandMax {
		return nil
	}
	agent := hooks.ResolveAgentName(map[string]any{})
	if agent == "" {
		return nil
	}
	sessionID := hooks.ResolveSessionID("")
	raw, err := ask(agent, sessionID, map[string]any{
		"session_id":  sessionID,
		"tool_use_id": id,
		"tool_name":   "bash",
		"tool_input":  map[string]any{"command": command},
		"gate_only":   true,
	})
	if err != nil {
		hooks.DebugLog(fmt.Sprintf("PI_GATE_POST_FAILED: %v", err))
		return nil
	}
	var r struct {
		Refuse string `json:"refuse"`
	}
	if json.Unmarshal(raw, &r) != nil || r.Refuse == "" {
		return nil
	}
	if len(r.Refuse) > piGateRefuseMax || !strings.HasPrefix(r.Refuse, piGateOpener) || !piGateText.MatchString(r.Refuse) {
		return nil
	}
	line, err := json.Marshal(map[string]string{"refuse": r.Refuse})
	if err != nil {
		return nil
	}
	return line
}
