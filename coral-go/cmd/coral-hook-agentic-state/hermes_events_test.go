package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
)

// #11831: Coral's entries in Hermes's config.yaml run this binary with --hermes <event>; fromHermes reads an allow-list of keys and nothing else.

const hermesCanary = "CANARY-SECRET-9C21"

var hermesTestID = "local-" + strings.Repeat("a1", 32)

func TestHermesEventNamesMapToTheHooksTheProgramReads(t *testing.T) {
	assert.Equal(t, map[string]string{
		"on_session_start": "SessionStart", "pre_llm_call": "UserPromptSubmit", "pre_tool_call": "PreToolUse", "post_tool_call": "PostToolUse",
		"on_session_end": "Stop", "on_human_input_request": "PermissionRequest", "on_human_input_resolved": "ElicitationResult", "on_session_finalize": "SessionEnd",
	}, hermesEventNames)
	assert.Equal(t, "Stop", parseArgs([]string{"--hermes", "on_session_end"}).hermesEvent)
	for _, ev := range []string{"pre_api_request", "post_api_request", "post_llm_call", "api_request_error", "pre_approval_request", "post_approval_response", "", "ON_SESSION_END"} {
		assert.Equal(t, "", parseArgs([]string{"--hermes", ev}).hermesEvent, ev)
	}
	assert.Equal(t, "", parseArgs([]string{"--hermes"}).hermesEvent)
}

func TestFromHermesTranslatesEachEvent(t *testing.T) {
	extra := func(kv ...any) map[string]any {
		m := map[string]any{}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return map[string]any{"extra": m}
	}
	with := func(base map[string]any, more map[string]any) map[string]any {
		out := map[string]any{"session_id": hermesTestID}
		for k, v := range base {
			out[k] = v
		}
		for k, v := range more {
			out[k] = v
		}
		return out
	}
	cases := []struct {
		name string
		hook string
		in   map[string]any
		want map[string]any
	}{
		{"start", "SessionStart", with(nil, nil), map[string]any{"hook_event_name": "SessionStart", "session_id": hermesTestID, "source": "startup"}},
		{"a turn starts", "UserPromptSubmit", with(nil, extra("user_message", hermesCanary)), map[string]any{"hook_event_name": "UserPromptSubmit", "session_id": hermesTestID}},
		{"a tool starts", "PreToolUse", with(map[string]any{"tool_name": "terminal"}, extra("tool_call_id", "call_1")), map[string]any{"hook_event_name": "PreToolUse", "session_id": hermesTestID, "tool_name": "terminal", "tool_use_id": "call_1"}},
		{"a tool ends ok", "PostToolUse", with(map[string]any{"tool_name": "terminal"}, extra("tool_call_id", "call_1", "status", "ok")), map[string]any{"hook_event_name": "PostToolUse", "session_id": hermesTestID, "tool_name": "terminal", "tool_use_id": "call_1"}},
		{"a tool fails", "PostToolUse", with(map[string]any{"tool_name": "terminal"}, extra("status", "error", "result", hermesCanary)), map[string]any{"hook_event_name": "PostToolUse", "session_id": hermesTestID, "tool_name": "terminal", "error": "tool error"}},
		{"a turn ends", "Stop", with(nil, extra("completed", true, "assistant_response", hermesCanary)), map[string]any{"hook_event_name": "Stop", "session_id": hermesTestID, "reason": "end_turn"}},
		{"a turn is interrupted", "Stop", with(nil, extra("interrupted", true)), map[string]any{"hook_event_name": "Stop", "session_id": hermesTestID, "reason": "aborted"}},
		{"a turn fails", "Stop", with(nil, extra("failed", true)), map[string]any{"hook_event_name": "Stop", "session_id": hermesTestID, "reason": "aborted"}},
		{"an approval is asked", "PermissionRequest", with(map[string]any{"tool_input": map[string]any{"command": hermesCanary}}, extra("command", hermesCanary, "kind", "approval")), map[string]any{"hook_event_name": "PermissionRequest", "session_id": hermesTestID, "tool_name": "approval"}},
		{"it is answered", "ElicitationResult", with(nil, extra("outcome", "once")), map[string]any{"hook_event_name": "ElicitationResult", "session_id": hermesTestID, "action": "answered"}},
		{"close", "SessionEnd", with(nil, extra("reason", "cli_close")), map[string]any{"hook_event_name": "SessionEnd", "session_id": hermesTestID, "reason": "prompt_input_exit"}},
		{"another finalize reason", "SessionEnd", with(nil, extra("reason", "x")), map[string]any{"hook_event_name": "SessionEnd", "session_id": hermesTestID, "reason": "other"}},
	}
	for _, c := range cases {
		got, ok := fromHermes(c.in, c.hook)
		require.True(t, ok, c.name)
		assert.Equal(t, c.want, got, c.name)
		b, _ := json.Marshal(got)
		assert.NotContains(t, string(b), hermesCanary, c.name+": nothing but the allow-list is read")
	}
}

func TestFromHermesDropsWhatIsNotSafe(t *testing.T) {
	// a session id that is not a Hermes id is not carried (the banner's 8 characters, a path, an option)
	for _, id := range []string{"d7b90358", "../x", "--yolo", "local-abc", hermesTestID + "0", strings.ToUpper(hermesTestID), ""} {
		got, ok := fromHermes(map[string]any{"session_id": id}, "UserPromptSubmit")
		require.True(t, ok)
		_, has := got["session_id"]
		assert.False(t, has, id)
	}
	// a tool event with no usable name is not recorded; a name with a bidi override or a control character is dropped, not repaired
	for _, name := range []any{nil, "", 5, "te‮rminal", "ter\x1bminal", "a​b", strings.Repeat("x", 300)} {
		_, ok := fromHermes(map[string]any{"tool_name": name}, "PreToolUse")
		assert.False(t, ok, "%v", name)
	}
	// a tool call id that is not a plain id is not carried
	got, ok := fromHermes(map[string]any{"tool_name": "t", "extra": map[string]any{"tool_call_id": "x y; rm"}}, "PreToolUse")
	require.True(t, ok)
	_, has := got["tool_use_id"]
	assert.False(t, has)
	// an event that is not one is dropped
	_, ok = fromHermes(map[string]any{}, "Whatever")
	assert.False(t, ok)
	// extra of the wrong type is read as nothing
	got, ok = fromHermes(map[string]any{"extra": "x"}, "Stop")
	require.True(t, ok)
	assert.Equal(t, "end_turn", got["reason"])
}

// The events Coral installs in Hermes's config.yaml are exactly the ones this program records.
func TestTheInstalledHermesHooksAreTheOnesRecorded(t *testing.T) {
	var recorded []string
	for ev := range hermesEventNames {
		recorded = append(recorded, ev)
	}
	assert.ElementsMatch(t, recorded, agent.HermesHookEvents())
}

// Hermes runs its hooks in ITS OWN install folder, whatever folder the agent works in (#11715), so the payload's folder is not the agent's name; the launch line's CORAL_HERMES_WORKDIR is. The event is
// posted for the agent's own folder name and reads as the turn it is.
func TestAHermesHookIsPostedForTheAgentsOwnFolderNotHermesInstallFolder(t *testing.T) {
	res := runFlow(t, flowRun{
		cli: "hermes", args: []string{"--hermes", "pre_llm_call"},
		stdin: flowPayload(t, map[string]any{"hook_event_name": "pre_llm_call", "session_id": hermesTestID, "cwd": "/opt/hermes-agent", "extra": map[string]any{"user_message": hermesCanary}}),
		env:   []string{"CORAL_HERMES_WORKDIR=/work/dev"},
	})
	require.NotEmpty(t, res.Requests)
	b, _ := json.Marshal(res)
	assert.NotContains(t, string(b), hermesCanary)
	assert.NotContains(t, string(b), "hermes-agent", "the install folder is not a name")
	var posted bool
	for _, r := range res.Requests {
		if r.Method == "POST" && r.Path == "/api/sessions/live/dev/events" {
			posted = true
			assert.Equal(t, "prompt_submit", r.Body.(map[string]any)["event_type"])
		}
	}
	assert.True(t, posted, "%s", b)
}

func TestAHermesHookWithNoWorkdirPostsNothing(t *testing.T) {
	res := runFlow(t, flowRun{
		cli: "hermes", args: []string{"--hermes", "pre_llm_call"},
		stdin: flowPayload(t, map[string]any{"session_id": hermesTestID, "cwd": "/opt/hermes-agent"}),
	})
	assert.Empty(t, res.Requests, "no name, no post under the install folder's")
	for _, bad := range []string{"..", "/", "."} {
		res = runFlow(t, flowRun{cli: "hermes", args: []string{"--hermes", "pre_llm_call"}, stdin: flowPayload(t, map[string]any{}), env: []string{"CORAL_HERMES_WORKDIR=" + bad}})
		assert.Empty(t, res.Requests, bad)
	}
}
