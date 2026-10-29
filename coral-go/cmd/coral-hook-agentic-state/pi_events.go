package main

import (
	"math"
	"regexp"

	"github.com/subgentic/coral/internal/hooks"
)

// Pi (#11093, #11102): Coral's bundled Pi extension (internal/agent/pi_extension) posts these hooks the way Antigravity's do, through this binary: `coral-hook-agentic-state --pi <event>` with a MINIMAL JSON
// on standard input, which fromPi turns into the Claude shape the rest of this program reads. What the extension may send is an allow-list (piAllowedKeys): an event name, ids, a tool NAME, flags, the model and
// thinking-level NAMES and token counts. A prompt, a tool's arguments or result, a message or a file's content is not in it, and fromPi never reads one even if a payload carries it (a canary test pins that).
// The state it gives is display only: whatever posts here (the extension, or anything running as the user) can claim any state, as the Claude hooks can.

// piAllowedKeys are the only keys of a Pi payload this program reads.
var piAllowedKeys = []string{"session_id", "reason", "tool_name", "tool_use_id", "is_error", "aborted", "model", "thinking_level", "input_tokens", "output_tokens", "cost_usd", "num_turns"}

var piSafeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// piName is a short name (a tool, a model, a level) or "" when it is not one: printable, no control characters, bounded.
func piName(v any, max int) string {
	s, _ := v.(string)
	if s == "" || len(s) > 200 {
		return ""
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	return hooks.Truncate(s, max)
}

// piCount is a token count or a cost: a finite, non-negative number, or nil.
func piCount(v any) any {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1e12 {
		return nil
	}
	return f
}

// fromPi translates a Pi extension payload for event into the Claude shape. An event Coral does not record is dropped (false).
//   - session_start: SessionStart (source: startup, or resume for a resumed or forked session, clear for /new).
//   - agent_start: UserPromptSubmit (the agent is Working).
//   - tool_execution_start / tool_execution_end: PreToolUse / PostToolUse by tool NAME only (no arguments, no result); a failed tool is a fixed "tool error", never its text.
//   - agent_settled: Stop, with the run's token counts when it carries them; aborted (Escape) says "aborted".
//   - session_shutdown: SessionEnd.
func fromPi(d map[string]any, event string) (map[string]any, bool) {
	out := map[string]any{"hook_event_name": event}
	if id, _ := d["session_id"].(string); piSafeID.MatchString(id) {
		out["session_id"] = id
	}
	switch event {
	case "SessionStart":
		out["source"] = "startup"
		switch r, _ := d["reason"].(string); r {
		case "resume", "fork":
			out["source"] = "resume"
		case "new":
			out["source"] = "clear"
		}
	case "UserPromptSubmit":
	case "PreToolUse", "PostToolUse":
		tool := piName(d["tool_name"], 60)
		if tool == "" {
			return nil, false
		}
		out["tool_name"] = tool
		if id, _ := d["tool_use_id"].(string); piSafeID.MatchString(id) {
			out["tool_use_id"] = id
		}
		if failed, _ := d["is_error"].(bool); failed && event == "PostToolUse" {
			out["error"] = "tool error"
		}
	case "Stop":
		out["reason"] = "end_turn"
		if aborted, _ := d["aborted"].(bool); aborted {
			out["reason"] = "aborted"
		}
		if m := piName(d["model"], 80); m != "" {
			out["model"] = m
		}
		if v := piCount(d["input_tokens"]); v != nil {
			out["total_input_tokens"] = v
		}
		if v := piCount(d["output_tokens"]); v != nil {
			out["total_output_tokens"] = v
		}
		if v := piCount(d["cost_usd"]); v != nil {
			out["total_cost_usd"] = v
		}
		if v := piCount(d["num_turns"]); v != nil {
			out["num_turns"] = v
		}
	case "SessionEnd":
		out["reason"] = "other"
		if r, _ := d["reason"].(string); r == "quit" {
			out["reason"] = "prompt_input_exit"
		}
	default:
		return nil, false
	}
	return out, true
}

// piEventNames maps the extension's events to the hook names above. The extension sends the Pi event name; an unknown one is not recorded.
var piEventNames = map[string]string{
	"session_start":        "SessionStart",
	"agent_start":          "UserPromptSubmit",
	"tool_execution_start": "PreToolUse",
	"tool_execution_end":   "PostToolUse",
	"agent_settled":        "Stop",
	"session_shutdown":     "SessionEnd",
}
