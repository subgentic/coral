package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/hooks"
	"github.com/subgentic/coral/internal/testguard"
)

// #8430: what main() does with a payload, end to end: the requests it makes to Coral (which path, in what order, with what body) and what it prints for the CLI. The hook runs as the CLIs run it (a child
// process with the payload on stdin and an isolated home) against a fake Coral that records everything, so the golden is the whole contract of the hook; main is split into named steps behind it.

const (
	flowSessionID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	flowCWD       = "/work/dev" // the agent's name is the last element of the payload's folder
)

type flowRun struct {
	cli       string   // the CLI's session-name prefix: claude, codex or agy
	args      []string // the hook's own arguments
	stdin     []byte
	turnEnd   string // what Coral answers to a turn-end question
	failEvent bool   // Coral answers the events post with a 500
}

type flowRequest struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   any    `json:"body,omitempty"`
}

type flowResult struct {
	Requests []flowRequest `json:"requests"`
	Stdout   string        `json:"stdout,omitempty"`
}

// TestHookFlowHelperProcess is the hook itself, run as a child of runFlow (never on its own).
func TestHookFlowHelperProcess(t *testing.T) {
	if os.Getenv("CORAL_HOOK_FLOW_HELPER") != "1" {
		t.Skip("not the helper process")
	}
	var args []string
	if v := os.Getenv("CORAL_HOOK_FLOW_ARGS"); v != "" {
		require.NoError(t, json.Unmarshal([]byte(v), &args))
	}
	os.Args = append([]string{"coral-hook-agentic-state"}, args...)
	main()
}

func runFlow(t *testing.T, run flowRun) flowResult {
	t.Helper()
	var mu sync.Mutex
	var reqs []flowRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body any
		if len(b) > 0 {
			_ = json.Unmarshal(b, &body)
		}
		mu.Lock()
		reqs = append(reqs, flowRequest{Method: r.Method, Path: r.URL.Path, Body: body})
		mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/turn-end"):
			answer := run.turnEnd
			if answer == "" {
				answer = `{"handoff":false}`
			}
			_, _ = w.Write([]byte(answer))
		case run.failEvent && strings.HasSuffix(r.URL.Path, "/events"):
			http.Error(w, `{"error":"boom"}`, http.StatusInternalServerError)
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	home := t.TempDir()
	args, err := json.Marshal(run.args)
	require.NoError(t, err)
	cmd := exec.Command(os.Args[0], "-test.run=^TestHookFlowHelperProcess$")
	cmd.Stdin = bytes.NewReader(run.stdin)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Env = []string{
		"CORAL_HOOK_FLOW_HELPER=1", "CORAL_HOOK_FLOW_ARGS=" + string(args), "TESTGUARD_AGENT_ENV_SCRUBBED=1",
		"HOME=" + home, "USERPROFILE=" + home, "ANTIGRAVITY_DATA_DIR=" + filepath.Join(home, "agy"), "CODEX_HOME=" + filepath.Join(home, "codex"),
		"CORAL_DATA_DIR=" + filepath.Join(home, "coral"), "CORAL_SESSION_ID=" + flowSessionID, "CORAL_SESSION_NAME=" + run.cli + "-" + flowSessionID,
		"CORAL_URL=" + srv.URL, testguard.TestURLEnv + "=1", "PATH=" + os.Getenv("PATH"),
	}
	require.NoError(t, cmd.Run(), "the hook exits 0 whatever happens (a hook that fails stops the CLI)")

	mu.Lock()
	defer mu.Unlock()
	res := flowResult{Requests: []flowRequest{}, Stdout: strings.TrimSuffix(stdout.String(), "PASS\n")} // the test binary prints PASS after main returns
	for _, r := range reqs {
		if strings.HasPrefix(r.Path, "/api/sessions/live/") { // the hook's own proofs of identity are not part of its contract here
			res.Requests = append(res.Requests, r)
		}
	}
	return res
}

func flowPayload(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	if _, ok := fields["cwd"]; !ok {
		fields["cwd"] = flowCWD
	}
	b, err := json.Marshal(fields)
	require.NoError(t, err)
	return b
}

func readFlowFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	return b
}

func flowScenarios(t *testing.T) map[string]flowRun {
	s := map[string]flowRun{}
	add := func(name, cli string, fields map[string]any, args ...string) {
		s[name] = flowRun{cli: cli, args: args, stdin: flowPayload(t, fields)}
	}
	bash := map[string]any{"command": "go test ./..."}

	add("claude PreToolUse records the pending tool", "claude", map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": bash})
	add("claude PreToolUse without a tool name records nothing", "claude", map[string]any{"hook_event_name": "PreToolUse", "tool_input": bash})
	add("claude PostToolUse is an activity event", "claude", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": bash, "tool_response": map[string]any{"stdout": "ok", "stderr": ""}})
	add("claude PostToolUseFailure", "claude", map[string]any{"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": bash, "error": "exit status 1"})
	add("claude UserPromptSubmit", "claude", map[string]any{"hook_event_name": "UserPromptSubmit", "prompt": "please fix the build"})
	add("claude Notification", "claude", map[string]any{"hook_event_name": "Notification", "message": "Claude is waiting for your input"})
	add("claude Stop is an event", "claude", map[string]any{"hook_event_name": "Stop", "stop_hook_active": false})
	add("claude Stop forwards the token usage", "claude", map[string]any{"hook_event_name": "Stop", "total_input_tokens": 1200, "total_output_tokens": 340, "total_cost_usd": 0.0421, "num_turns": 3})
	add("claude Stop with only a cost forwards the usage", "claude", map[string]any{"hook_event_name": "Stop", "total_cost_usd": 1.5})
	add("claude Stop already handed over is an event, with no question to Coral", "claude", map[string]any{"hook_event_name": "Stop", "stop_hook_active": true})
	add("claude SessionStart", "claude", map[string]any{"hook_event_name": "SessionStart", "source": "startup"})
	add("claude --session-clear marks the clear", "claude", map[string]any{"hook_event_name": "UserPromptSubmit", "prompt": "/clear"}, "--session-clear")
	add("claude --hooks-rev is on the event", "claude", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": map[string]any{"file_path": "/work/dev/a.go"}}, "--hooks-rev", "7")
	add("claude --hooks-rev that is not a number is ignored", "claude", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": map[string]any{"file_path": "/work/dev/a.go"}}, "--hooks-rev", "x")
	add("claude permission_mode is on the event", "claude", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": map[string]any{"file_path": "/work/dev/a.go"}, "permission_mode": "plan"})
	add("claude permission_mode that is not a mode is dropped", "claude", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": map[string]any{"file_path": "/work/dev/a.go"}, "permission_mode": "yolo"})
	add("the event is named by hook_event_name before type", "claude", map[string]any{"hook_event_name": "Stop", "type": "Notification", "message": "m"})
	add("the event is named by type when there is no hook_event_name", "claude", map[string]any{"type": "UserPromptSubmit", "event": "Stop", "prompt": "p"})
	add("the event is named by event before event_name", "claude", map[string]any{"event": "Notification", "event_name": "Stop", "message": "m"})
	add("claude PermissionRequest", "claude", map[string]any{"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": bash})
	add("codex permission_mode is not sent", "codex", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": map[string]any{"file_path": "/work/dev/a.go"}, "permission_mode": "plan"})
	add("codex PreToolUse with arguments instead of tool_input (#8389)", "codex", map[string]any{"hook_event_name": "PreToolUse", "tool_name": "shell", "tool_use_id": "call_1", "arguments": map[string]any{"command": []string{"ls", "-la"}}})
	add("codex PostToolUse with arguments instead of tool_input (#8389)", "codex", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "shell", "tool_use_id": "call_1", "arguments": map[string]any{"command": []string{"ls", "-la"}}, "tool_response": "total 0"})
	add("codex PreToolUse with input", "codex", map[string]any{"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "input": map[string]any{"patch": "*** Begin Patch"}})
	add("codex Stop is an event with no turn-end question", "codex", map[string]any{"hook_event_name": "Stop"})
	s["agy PreToolUse ask_question is a wait"] = flowRun{cli: "agy", args: []string{"--agy", "PreToolUse", "--hooks-rev", "3"}, stdin: readFlowFile(t, filepath.Join("testdata", "agy-1.4.2", "PreToolUse-ask_question.json"))}
	add("agy event Coral does not record is dropped", "agy", map[string]any{"modelName": "agy-model-x"}, "--agy", "SomethingElse")
	add("no agent name drops the event", "claude", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": bash, "cwd": "/"})

	agyStop := readFlowFile(t, filepath.Join("testdata", "agy-1.4.7", "Stop-0.json"))
	s["an agy Stop is not handed board messages, whatever the session is called"] = flowRun{cli: "claude", args: []string{"--agy", "Stop"}, stdin: agyStop}
	var agyPost map[string]any
	require.NoError(t, json.Unmarshal(readFlowFile(t, filepath.Join("testdata", "agy-1.4.7", "PostToolUse-0.json")), &agyPost))
	agyPost["permission_mode"] = "plan"
	agyPostJSON, err := json.Marshal(agyPost)
	require.NoError(t, err)
	s["an agy event carries no permission_mode, whatever the session is called"] = flowRun{cli: "claude", args: []string{"--agy", "PostToolUse"}, stdin: agyPostJSON}
	s["claude Stop hands over board messages and records no stop"] = flowRun{cli: "claude", stdin: flowPayload(t, map[string]any{"hook_event_name": "Stop", "total_input_tokens": 10}),
		turnEnd: `{"handoff":true,"reason":"New board messages","context":"Coral board: 2 new messages on team. Run coral-board read to read them, then carry on."}`}
	s["claude Stop a hand-off without a reason is not one"] = flowRun{cli: "claude", stdin: flowPayload(t, map[string]any{"hook_event_name": "Stop"}), turnEnd: `{"handoff":true}`}
	s["claude Stop when Coral answers the events post with a 500: the usage still follows (a status is not a failure to the hook)"] = flowRun{cli: "claude", stdin: flowPayload(t, map[string]any{"hook_event_name": "Stop", "total_input_tokens": 10}), failEvent: true}
	s["claude PostToolUse when Coral refuses the event"] = flowRun{cli: "claude", stdin: flowPayload(t, map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": bash}), failEvent: true}
	s["not JSON records nothing"] = flowRun{cli: "claude", stdin: []byte("this is not json")}
	s["a payload over the size bound records nothing"] = flowRun{cli: "claude", stdin: append([]byte(`{"hook_event_name":"PostToolUse","pad":"`), append(bytes.Repeat([]byte("a"), hooks.MaxHookStdin), []byte(`"}`)...)...)}
	s["an empty stdin records nothing"] = flowRun{cli: "claude", stdin: nil}

	// The recorded payloads of each CLI, one run each.
	for _, c := range []struct{ dir, cli string }{{"claude-2.1.300", "claude"}, {"codex-0.155.1", "codex"}, {"codex-0.163.0", "codex"}, {"agy-1.4.2", "agy"}, {"agy-1.4.7", "agy"}} {
		files, err := filepath.Glob(filepath.Join("testdata", c.dir, "*.json"))
		require.NoError(t, err)
		require.NotEmpty(t, files, c.dir)
		for _, f := range files {
			name := "corpus " + c.dir + "/" + strings.TrimSuffix(filepath.Base(f), ".json")
			run := flowRun{cli: c.cli, stdin: readFlowFile(t, f)}
			if c.cli == "agy" {
				run.args = []string{"--agy", strings.SplitN(filepath.Base(f), "-", 2)[0]}
			}
			s[name] = run
		}
	}
	return s
}

func TestMainFlowGolden(t *testing.T) {
	scenarios := flowScenarios(t)
	names := make([]string, 0, len(scenarios))
	for n := range scenarios {
		names = append(names, n)
	}
	sort.Strings(names)
	results := map[string]flowResult{}
	for _, n := range names {
		results[n] = runFlow(t, scenarios[n])
	}
	got, err := json.MarshalIndent(results, "", "  ")
	require.NoError(t, err)
	got = append(got, '\n')
	path := filepath.Join("testdata", "main_flow.golden.json")
	if os.Getenv("CORAL_UPDATE_GOLDEN") != "" {
		require.NoError(t, os.WriteFile(path, got, 0o644))
		return
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "CORAL_UPDATE_GOLDEN=1 writes it")
	require.Equal(t, string(want), string(got), "what the hook does changed: read the diff, then CORAL_UPDATE_GOLDEN=1")
}
