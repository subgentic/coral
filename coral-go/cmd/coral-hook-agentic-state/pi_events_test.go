package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11093/#11102: Coral's Pi extension posts through this binary with --pi <event>; fromPi reads an allow-list of keys and nothing else.

const piCanary = "CANARY-SECRET-7F3A"

func TestPiEventNamesMapToTheHooksTheProgramReads(t *testing.T) {
	assert.Equal(t, map[string]string{
		"session_start": "SessionStart", "agent_start": "UserPromptSubmit", "tool_execution_start": "PreToolUse", "tool_execution_end": "PostToolUse", "agent_settled": "Stop", "session_shutdown": "SessionEnd",
	}, piEventNames)
	assert.Equal(t, "Stop", parseArgs([]string{"--pi", "agent_settled"}).piEvent)
	assert.Equal(t, "", parseArgs([]string{"--pi", "tool_call"}).piEvent, "an event that can gate Pi's work is not one this program records")
	assert.Equal(t, "", parseArgs([]string{"--pi", "input"}).piEvent)
	assert.Equal(t, "", parseArgs([]string{"--pi"}).piEvent)
}

func TestFromPiTranslatesEachEvent(t *testing.T) {
	cases := []struct {
		name  string
		event string
		in    map[string]any
		want  map[string]any
	}{
		{"startup", "SessionStart", map[string]any{"session_id": "s-1", "reason": "startup"}, map[string]any{"hook_event_name": "SessionStart", "session_id": "s-1", "source": "startup"}},
		{"resume", "SessionStart", map[string]any{"reason": "resume"}, map[string]any{"hook_event_name": "SessionStart", "source": "resume"}},
		{"fork", "SessionStart", map[string]any{"reason": "fork"}, map[string]any{"hook_event_name": "SessionStart", "source": "resume"}},
		{"new is a clear", "SessionStart", map[string]any{"reason": "new"}, map[string]any{"hook_event_name": "SessionStart", "source": "clear"}},
		{"a run starts", "UserPromptSubmit", map[string]any{"session_id": "s-1"}, map[string]any{"hook_event_name": "UserPromptSubmit", "session_id": "s-1"}},
		{"a tool starts", "PreToolUse", map[string]any{"tool_name": "bash", "tool_use_id": "call_1"}, map[string]any{"hook_event_name": "PreToolUse", "tool_name": "bash", "tool_use_id": "call_1"}},
		{"a tool ends well", "PostToolUse", map[string]any{"tool_name": "ls", "tool_use_id": "call_2", "is_error": false}, map[string]any{"hook_event_name": "PostToolUse", "tool_name": "ls", "tool_use_id": "call_2"}},
		{"a tool fails: a fixed word, never its text", "PostToolUse", map[string]any{"tool_name": "ls", "is_error": true}, map[string]any{"hook_event_name": "PostToolUse", "tool_name": "ls", "error": "tool error"}},
		{"the run settles", "Stop", map[string]any{"input_tokens": 11.0, "output_tokens": 5.0, "cost_usd": 0.5, "num_turns": 2.0, "model": "fake-chat"},
			map[string]any{"hook_event_name": "Stop", "reason": "end_turn", "model": "fake-chat", "total_input_tokens": 11.0, "total_output_tokens": 5.0, "total_cost_usd": 0.5, "num_turns": 2.0}},
		{"Escape", "Stop", map[string]any{"aborted": true}, map[string]any{"hook_event_name": "Stop", "reason": "aborted"}},
		{"quit", "SessionEnd", map[string]any{"reason": "quit"}, map[string]any{"hook_event_name": "SessionEnd", "reason": "prompt_input_exit"}},
		{"another shutdown", "SessionEnd", map[string]any{"reason": "reload"}, map[string]any{"hook_event_name": "SessionEnd", "reason": "other"}},
	}
	for _, c := range cases {
		got, ok := fromPi(c.in, c.event)
		require.True(t, ok, c.name)
		assert.Equal(t, c.want, got, c.name)
	}
	_, ok := fromPi(map[string]any{}, "PreToolUse")
	assert.False(t, ok, "a tool event with no tool name is dropped")
	_, ok = fromPi(map[string]any{"tool_name": "a\nb"}, "PreToolUse")
	assert.False(t, ok, "a tool name with a control character is dropped")
	_, ok = fromPi(map[string]any{}, "PermissionRequest")
	assert.False(t, ok, "an event the extension has no business sending")
}

func TestFromPiBadValuesAreDropped(t *testing.T) {
	got, ok := fromPi(map[string]any{"session_id": "../../etc", "input_tokens": -1.0, "output_tokens": "many", "cost_usd": 1e30, "model": strings.Repeat("m", 500)}, "Stop")
	require.True(t, ok)
	assert.NotContains(t, got, "session_id", "an id that is not an id is not passed on")
	for _, k := range []string{"total_input_tokens", "total_output_tokens", "total_cost_usd", "model"} {
		assert.NotContains(t, got, k, k)
	}
}

// The canary: a payload that carries everything Pi has (a prompt, a tool's arguments and result, messages, text, a key) puts none of it into what the rest of the program reads, nor into the event it would post.
func TestFromPiNeverReadsAnythingOutsideTheAllowList(t *testing.T) {
	d := map[string]any{"session_id": "s-1", "tool_name": "bash", "tool_use_id": "call_9", "is_error": true, "aborted": false}
	for _, k := range []string{"prompt", "text", "args", "tool_input", "result", "output", "messages", "message", "systemPrompt", "content", "command", "api_key", "env", "images", "summary", "input", "error", "last_assistant_message", "transcript_path"} {
		d[k] = piCanary + " " + k
	}
	d["args"] = map[string]any{"command": piCanary}
	for event, hook := range piEventNames {
		out, ok := fromPi(d, hook)
		require.True(t, ok, event)
		raw, _ := json.Marshal(out)
		assert.NotContains(t, string(raw), piCanary, event+": the translated payload")
		posted := parseAgenticEvent(out, hookTypeOf(out), "s-1")
		rawEvent, _ := json.Marshal(posted)
		assert.NotContains(t, string(rawEvent), piCanary, event+": the event that would be posted")
		for k := range out {
			assert.Contains(t, append([]string{"hook_event_name", "source", "reason", "error", "model", "tool_name", "tool_use_id", "session_id", "total_input_tokens", "total_output_tokens", "total_cost_usd", "num_turns"}, piAllowedKeys...), k, event+": key "+k+" is not one fromPi may write")
		}
	}
}
