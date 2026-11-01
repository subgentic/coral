package main

import (
	"github.com/subgentic/coral/internal/hermesdb"
)

// Hermes (#11831): Hermes Agent runs the shell hooks of its config.yaml (the one Coral writes in its own HERMES_HOME) with a JSON object on standard input; Coral's entries run this binary as
// `coral-hook-agentic-state --hermes <event>`. fromHermes turns the payload into the Claude shape the rest of this program reads, from an ALLOW-LIST: the event name, the session id (a Hermes id: local- and 64 hex), a
// tool NAME, the tool call's id, and a few flags in `extra`. A prompt, an assistant reply, a tool's input or result, a command or a working folder is not in it, and fromHermes never reads one even if the payload carries it
// (a canary test pins that). The state it gives is display only: whatever posts here can claim any state, as the Claude hooks can.
//
// What the events mean (checked on Hermes v0.22.5, #11715):
//   - on_session_start: SessionStart (the first turn only; not on a resume).
//   - pre_llm_call: UserPromptSubmit: the agent is Working.
//   - pre_tool_call / post_tool_call: PreToolUse / PostToolUse by tool NAME; a call whose status is not ok is a fixed "tool error", never its text.
//   - on_session_end: Stop. It fires at the end of EVERY TURN, not at exit. interrupted or failed says "aborted". An interrupt with Ctrl-C and a provider that gave up fire NO closing hook: the working state is
//     closed by the fallback (internal/server/routes hermes state), not by anything here.
//   - on_human_input_request: PermissionRequest (an approval is pending); on_human_input_resolved: ElicitationResult (answered).
//   - on_session_finalize: SessionEnd (the process is closing).
//   - every other event (the api request ones, post_llm_call, approval events that repeat the above) is not recorded.

// hermesEventNames maps Hermes's event names to the hook names above.
var hermesEventNames = map[string]string{
	"on_session_start":        "SessionStart",
	"pre_llm_call":            "UserPromptSubmit",
	"pre_tool_call":           "PreToolUse",
	"post_tool_call":          "PostToolUse",
	"on_session_end":          "Stop",
	"on_human_input_request":  "PermissionRequest",
	"on_human_input_resolved": "ElicitationResult",
	"on_session_finalize":     "SessionEnd",
}

// hermesExtra reads a key of the payload's extra object, a string or a bool, and nothing else of it.
func hermesExtra(d map[string]any, key string) any {
	extra, _ := d["extra"].(map[string]any)
	return extra[key]
}

// fromHermes translates a Hermes hook payload for the Claude hook name hook (a value of hermesEventNames). An event with nothing Coral can use (a tool event with no usable tool name) is dropped (false).
func fromHermes(d map[string]any, hook string) (map[string]any, bool) {
	out := map[string]any{"hook_event_name": hook}
	if id, _ := d["session_id"].(string); hermesdb.IsSessionID(id) {
		out["session_id"] = id
	}
	switch hook {
	case "SessionStart":
		out["source"] = "startup"
	case "UserPromptSubmit":
	case "PreToolUse", "PostToolUse":
		tool := piName(d["tool_name"], 60)
		if tool == "" {
			return nil, false
		}
		out["tool_name"] = tool
		if id, _ := hermesExtra(d, "tool_call_id").(string); piSafeID.MatchString(id) {
			out["tool_use_id"] = id
		}
		if status, _ := hermesExtra(d, "status").(string); hook == "PostToolUse" && status != "" && status != "ok" && status != "success" {
			out["error"] = "tool error"
		}
	case "Stop":
		out["reason"] = "end_turn"
		for _, k := range []string{"interrupted", "failed"} {
			if v, _ := hermesExtra(d, k).(bool); v {
				out["reason"] = "aborted"
			}
		}
	case "PermissionRequest":
		out["tool_name"] = "approval" // the request's own command is not read (it can hold anything): the row says that an approval is waiting
	case "ElicitationResult":
		out["action"] = "answered"
	case "SessionEnd":
		out["reason"] = "other"
		if r, _ := hermesExtra(d, "reason").(string); r == "cli_close" {
			out["reason"] = "prompt_input_exit"
		}
	default:
		return nil, false
	}
	return out, true
}
