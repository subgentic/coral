package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/transcriptlink"
)

// #8459 (Security's review of #8430): the rules of parseAgenticEvent and main that no payload of the corpus reached, one test each, so a later edit cannot change them unseen.

func detailOf(t *testing.T, ev map[string]any) map[string]any {
	t.Helper()
	require.NotNil(t, ev)
	d, _ := ev["detail_json"].(map[string]any)
	return d
}

// (a) A Codex shell call's exit code is looked up for its PostToolUse, when the response is text, and for a shell tool only.
func TestCodexExitCodeNeedsAPostToolUseATextResponseAndAShellTool(t *testing.T) {
	base := func() map[string]any { return codexCorpus(t, "PostToolUse-failed.json") }
	ev := parseAgenticEvent(base(), "PostToolUse", "sid")
	assert.Equal(t, 1, detailOf(t, ev)["exit_code"], "the control: the lookup runs")

	assert.NotContains(t, detailOf(t, parseAgenticEvent(base(), "PreToolUse", "sid")), "exit_code", "not a PostToolUse")
	assert.NotContains(t, detailOf(t, parseAgenticEvent(base(), "", "sid")), "exit_code", "no hook name")

	d := base()
	d["tool_response"] = map[string]any{"stdout": "x"}
	assert.NotContains(t, detailOf(t, parseAgenticEvent(d, "PostToolUse", "sid")), "exit_code", "a response that is not text")

	d = base()
	d["tool_name"] = "apply_patch"
	assert.NotContains(t, detailOf(t, parseAgenticEvent(d, "PostToolUse", "sid")), "exit_code", "not a shell tool")
}

// (b) An agy run_command's exit code is looked up for its PostToolUse, for run_command only.
func TestAgyExitCodeNeedsAPostToolUseAndRunCommand(t *testing.T) {
	payload := func() map[string]any {
		dir := t.TempDir()
		full, err := os.ReadFile(filepath.Join("testdata", "agy-1.4.2", "exit1", "transcript_full.jsonl"))
		require.NoError(t, err)
		lines := strings.SplitN(string(full), "\n", 3)
		transcript := filepath.Join(dir, "transcript_full.jsonl")
		require.NoError(t, os.WriteFile(transcript, []byte(lines[0]+"\n"+lines[1]+"\n"), 0o600))
		raw, err := os.ReadFile(filepath.Join("testdata", "agy-1.4.2", "PostToolUse-run_command-failed.json"))
		require.NoError(t, err)
		var d map[string]any
		require.NoError(t, json.Unmarshal(raw, &d))
		artifacts, err := filepath.Abs(filepath.Join("testdata", "agy-1.4.2", "exit1", "brain"))
		require.NoError(t, err)
		d["transcriptPath"], d["artifactDirectoryPath"] = transcript, artifacts
		in, ok := fromAgy(d, "PostToolUse")
		require.True(t, ok)
		return in
	}
	assert.Equal(t, 1, detailOf(t, parseAgenticEvent(payload(), "PostToolUse", "sid"))["exit_code"], "the control: the lookup runs")
	assert.NotContains(t, detailOf(t, parseAgenticEvent(payload(), "PreToolUse", "sid")), "exit_code", "not a PostToolUse")
	d := payload()
	d["tool_name"] = "view_file"
	assert.NotContains(t, detailOf(t, parseAgenticEvent(d, "PostToolUse", "sid")), "exit_code", "not run_command")
}

// (d, e) A failed tool call's error is cut at 300 bytes (hooks.Truncate), and an interrupt is said.
func TestToolFailureDetailCutsTheErrorAndSaysAnInterrupt(t *testing.T) {
	long := strings.Repeat("e", 400)
	ev := parseAgenticEvent(map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "x"}, "error": long, "is_interrupt": true}, "PostToolUseFailure", "sid")
	d := detailOf(t, ev)
	assert.Equal(t, strings.Repeat("e", 297)+"...", d["error"], "300 bytes, the last three a cut mark")
	assert.Equal(t, true, d["interrupted"])
	assert.Equal(t, true, d["failed"])

	exact := strings.Repeat("e", 300)
	assert.Equal(t, exact, detailOf(t, parseAgenticEvent(map[string]any{"tool_name": "Bash", "error": exact}, "PostToolUseFailure", "sid"))["error"], "300 bytes are kept whole")

	d = detailOf(t, parseAgenticEvent(map[string]any{"tool_name": "Bash", "error": "boom", "is_interrupt": false}, "PostToolUseFailure", "sid"))
	assert.NotContains(t, d, "interrupted", "not an interrupt")
	d = detailOf(t, parseAgenticEvent(map[string]any{"tool_name": "Bash", "error": "boom", "is_interrupt": "yes"}, "PostToolUseFailure", "sid"))
	assert.NotContains(t, d, "interrupted", "only a JSON true is one")
}

// (f) The time a tool call took, as the agent measured it: 0 and more are kept (in whole milliseconds), less than 0 is dropped.
func TestToolDurationIsKeptFromZeroUp(t *testing.T) {
	ev := func(ms any) map[string]any {
		d := map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "x"}}
		if ms != nil {
			d["duration_ms"] = ms
		}
		return parseAgenticEvent(d, "PostToolUse", "sid")
	}
	assert.Equal(t, int64(1234), ev(1234.9)["duration_ms"])
	assert.Equal(t, int64(0), ev(float64(0))["duration_ms"], "0 is a time")
	assert.NotContains(t, ev(float64(-1)), "duration_ms", "less than 0 is no time")
	assert.NotContains(t, ev(nil), "duration_ms")
	assert.NotContains(t, ev("12"), "duration_ms", "text is no time")
}

// (g, h, i, j) Which event a payload is when it names no hook: by the fields it has.
func TestAnUnnamedPayloadIsKnownByItsFields(t *testing.T) {
	stop := parseAgenticEvent(map[string]any{"stop_hook_active": false}, "", "sid")
	assert.Equal(t, "stop", stop["event_type"], "(g) a payload with stop_hook_active is a stop")
	assert.Equal(t, "Agent stopped: unknown", stop["summary"])

	note := parseAgenticEvent(map[string]any{"message": "needs you"}, "", "sid")
	assert.Equal(t, "notification", note["event_type"], "(h) a payload with only a message is a notification")
	assert.Equal(t, "Notification: needs you", note["summary"])

	long := strings.Repeat("m", 150)
	assert.Equal(t, "Notification: "+strings.Repeat("m", 97)+"...", parseAgenticEvent(map[string]any{"message": long}, "Notification", "sid")["summary"], "(i) the message is cut at 100 bytes")
	assert.Equal(t, "Notification: "+strings.Repeat("m", 100), parseAgenticEvent(map[string]any{"message": strings.Repeat("m", 100)}, "Notification", "sid")["summary"], "100 are kept whole")

	assert.Equal(t, "prompt_submit", parseAgenticEvent(map[string]any{"prompt": "hi"}, "", "sid")["event_type"], "a payload with only a prompt is a prompt")
	assert.Equal(t, "tool_use", parseAgenticEvent(map[string]any{"prompt": "hi", "tool_name": "Bash"}, "", "sid")["event_type"], "(j) with a tool name it is a tool call")
	assert.Equal(t, "stop", parseAgenticEvent(map[string]any{"prompt": "hi", "stop_hook_active": true}, "", "sid")["event_type"], "(j) with stop_hook_active it is a stop")
}

// (l) The hook name is read from event_name when no other key has it.
func TestHookTypeOfReadsEventNameLast(t *testing.T) {
	assert.Equal(t, "Stop", hookTypeOf(map[string]any{"event_name": "Stop"}))
	assert.Equal(t, "Notification", hookTypeOf(map[string]any{"event": "Notification", "event_name": "Stop"}))
	assert.Equal(t, "", hookTypeOf(map[string]any{"event_name": 7, "type": ""}))
	assert.Equal(t, "", hookTypeOf(map[string]any{}))
}

// (m) A Codex thread that is the session's own id is not bound again; another thread is.
func TestACodexThreadEqualToTheSessionIsNotBound(t *testing.T) {
	const session = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	const other = "01a14d4e-1a66-7893-b33a-f0de799b1d64"
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	t.Setenv("CORAL_SESSION_NAME", "codex-"+session)
	for _, id := range []string{session, other} {
		dir := filepath.Join(home, "sessions", "2026", "10", "26")
		require.NoError(t, os.MkdirAll(dir, 0o700))
		meta, err := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]any{"id": id}})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(dir, "rollout-2026-10-26T10-00-00-"+id+".jsonl"), append(meta, '\n'), 0o600))
	}

	bindTranscripts(map[string]any{"session_id": session}, session, "")
	assert.Empty(t, transcriptlink.Codex(session).ThreadID, "the session's own id is no thread to bind")

	bindTranscripts(map[string]any{"session_id": other}, session, "")
	assert.Equal(t, other, transcriptlink.Codex(session).ThreadID, "another thread is bound")
}
