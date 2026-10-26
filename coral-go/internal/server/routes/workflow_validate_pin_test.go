package routes

// Pinning tests for the workflow validators (#8315, from the round 2 list): what validateSteps, validateHooks, validateTemplateRefs, stepWarnings, withWarnings, canonicalizeRepoPath
// and stepFileType answer today, rule by rule and in the order the rules run, so that moving them out of workflow.go is proved by tests as well as by movecheck. Each row is one rule
// or one threshold. They are named TestPinWorkflow... so `go test ./internal/server/routes -run TestPinWorkflow` runs just these.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func pinRawSteps(t *testing.T, steps ...string) []json.RawMessage {
	t.Helper()
	var out []json.RawMessage
	for _, s := range steps {
		out = append(out, json.RawMessage(s))
	}
	return out
}

func TestPinWorkflowValidateSteps(t *testing.T) {
	const shellOK = `{"name":"build","type":"shell","command":"go build ./..."}`
	claudeOK := `{"name":"ask","type":"agent","prompt":"hi","agent":{"agent_type":"claude"}}`
	for _, c := range []struct {
		name         string
		steps        []string
		defaultAgent string
		want         string
	}{
		{"no steps is valid", nil, "", ""},
		{"a shell step", []string{shellOK}, "", ""},
		{"a claude agent step", []string{claudeOK}, "", ""},
		{"invalid JSON names the step", []string{shellOK, `{"name":`}, "", "step 1: invalid JSON"},
		{"name is required", []string{`{"type":"shell","command":"x"}`}, "", "step 0: name is required"},
		{"duplicate names", []string{shellOK, shellOK}, "", "duplicate step name"},
		{"shell needs a command", []string{`{"name":"a","type":"shell"}`}, "", "shell step missing command"},
		{"agent needs a prompt", []string{`{"name":"a","type":"agent","agent":{"agent_type":"claude"}}`}, "", "agent step missing prompt"},
		{"agent needs an agent type", []string{`{"name":"a","type":"agent","prompt":"p"}`}, "", "agent step missing agent_type"},
		{"agent type from the default agent", []string{`{"name":"a","type":"agent","prompt":"p"}`}, `{"agent_type":"claude"}`, ""},
		{"an empty step agent type falls back to the default", []string{`{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":""}}`}, `{"agent_type":"claude"}`, ""},
		{"the step's own agent type wins over the default", []string{`{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"nope"}}`}, `{"agent_type":"claude"}`, `step 0: unknown agent_type "nope"`},
		{"unknown agent type", []string{`{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"nope"}}`}, "", `step 0: unknown agent_type "nope"`},
		{"a print step on a CLI not verified yet", []string{`{"name":"a","type":"agent","prompt":"p","agent":{"agent_type":"codex"}}`}, "", "step 0: print (non-interactive) steps aren't supported for codex yet; use claude, or make the step interactive"},
		{"the same step, interactive, is fine", []string{`{"name":"a","type":"agent","prompt":"p","interactive":true,"agent":{"agent_type":"codex"}}`}, "", ""},
		{"type is required", []string{`{"name":"a","command":"x"}`}, "", "step 0: type must be 'shell' or 'agent'"},
		{"type must be known", []string{`{"name":"a","type":"python","command":"x"}`}, "", "step 0: type must be 'shell' or 'agent'"},
		{"timeout 1 is valid", []string{`{"name":"a","type":"shell","command":"x","timeout_s":1}`}, "", ""},
		{"timeout 86400 is valid", []string{`{"name":"a","type":"shell","command":"x","timeout_s":86400}`}, "", ""},
		{"timeout 86401 is not", []string{`{"name":"a","type":"shell","command":"x","timeout_s":86401}`}, "", "invalid timeout"},
		{"timeout 0 is not", []string{`{"name":"a","type":"shell","command":"x","timeout_s":0}`}, "", "invalid timeout"},
		{"timeout negative is not", []string{`{"name":"a","type":"shell","command":"x","timeout_s":-5}`}, "", "invalid timeout"},
		{"no timeout is valid", []string{`{"name":"a","type":"shell","command":"x"}`}, "", ""},
		{"output_artifact inside the folder", []string{`{"name":"a","type":"shell","command":"x","output_artifact":"out/report.txt"}`}, "", ""},
		{"output_artifact climbing out", []string{`{"name":"a","type":"shell","command":"x","output_artifact":"../report.txt"}`}, "", "step 0: output_artifact must be a relative path inside the step's folder (no absolute path, no ..)"},
		{"output_artifact absolute", []string{`{"name":"a","type":"shell","command":"x","output_artifact":"/etc/passwd"}`}, "", "step 0: output_artifact must be a relative path inside the step's folder (no absolute path, no ..)"},
		{"output_artifact with a NUL", []string{`{"name":"a","type":"shell","command":"x","output_artifact":"a\u0000b"}`}, "", "step 0: output_artifact must be a relative path inside the step's folder (no absolute path, no ..)"},
		{"template reference to a previous step", []string{shellOK, `{"name":"b","type":"shell","command":"cat {{step_0_stdout}}"}`}, "", ""},
		{"template reference on step 0 to the previous step", []string{`{"name":"a","type":"shell","command":"cat {{prev_stdout}}"}`}, "", "step 0 cannot reference previous step"},
		{"template reference to itself", []string{shellOK, `{"name":"b","type":"shell","command":"cat {{step_1_stdout}}"}`}, "", "template references invalid step index"},
		{"the prompt is checked for template references too", []string{`{"name":"a","type":"agent","prompt":"{{prev_dir}}","agent":{"agent_type":"claude"}}`}, "", "step 0 cannot reference previous step"},
		{"hooks are checked and named by step", []string{shellOK, `{"name":"b","type":"shell","command":"x","hooks":{"Nope":[]}}`}, "", `step 1: unknown hook event "Nope"`},
		{"valid hooks pass", []string{`{"name":"b","type":"shell","command":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo"}]}]}}`}, "", ""},
	} {
		var da json.RawMessage
		if c.defaultAgent != "" {
			da = json.RawMessage(c.defaultAgent)
		}
		assert.Equal(t, c.want, validateSteps(pinRawSteps(t, c.steps...), da), c.name)
	}

	// MCP servers are refused, in the default agent first and then in a step's agent
	assert.Equal(t, "default_agent: "+errMCPNotSupported, validateSteps(nil, json.RawMessage(`{"mcpServers":{"x":{}}}`)))
	assert.Equal(t, "step 0: agent: "+errMCPNotSupported, validateSteps(pinRawSteps(t, `{"name":"a","type":"shell","command":"x","agent":{"mcpServers":{"x":{}}}}`), nil))
	assert.Equal(t, "", validateSteps(pinRawSteps(t, `{"name":"a","type":"shell","command":"x","agent":{"mcpServers":null}}`), nil), "null is not given")

	// the order the rules run in: JSON, MCP, output_artifact, name, duplicate, type, timeout, templates, hooks
	assert.Equal(t, "step 0: output_artifact must be a relative path inside the step's folder (no absolute path, no ..)",
		validateSteps(pinRawSteps(t, `{"type":"shell","output_artifact":"../x"}`), nil), "output_artifact is checked before the name")
	assert.Equal(t, "shell step missing command", validateSteps(pinRawSteps(t, `{"name":"a","type":"shell","timeout_s":0}`), nil), "the type is checked before the timeout")
	assert.Equal(t, "invalid timeout", validateSteps(pinRawSteps(t, `{"name":"a","type":"shell","command":"{{prev_dir}}","timeout_s":0}`), nil), "the timeout before the templates")
	assert.Equal(t, "step 0 cannot reference previous step", validateSteps(pinRawSteps(t, `{"name":"a","type":"shell","command":"{{prev_dir}}","hooks":{"Nope":[]}}`), nil), "the templates before the hooks")
	assert.Equal(t, "duplicate step name", validateSteps(pinRawSteps(t, `{"name":"a","type":"shell","command":"x"}`, `{"name":"a","type":"python"}`), nil), "the duplicate before the type")
}

func TestPinWorkflowValidateHooks(t *testing.T) {
	group := `{"hooks":[{"type":"command","command":"echo hi"}]}`
	groups := func(n int) string { return "[" + strings.TrimSuffix(strings.Repeat(group+",", n), ",") + "]" }
	for _, c := range []struct {
		name string
		in   string
		want string
	}{
		{"one valid hook", `{"Stop":[` + group + `]}`, ""},
		{"every known event", `{"PreToolUse":[` + group + `],"PostToolUse":[` + group + `],"Stop":[` + group + `],"Notification":[` + group + `],"SubagentStop":[` + group + `],"StepComplete":[` + group + `],"StepFailed":[` + group + `]}`, ""},
		{"empty object is valid", `{}`, ""},
		{"null is valid (it decodes to no hooks)", `null`, ""},
		{"an array is not an object", `[]`, "hooks must be a JSON object"},
		{"a string is not an object", `"x"`, "hooks must be a JSON object"},
		{"an unknown event", `{"Nope":[]}`, `unknown hook event "Nope"`},
		{"event names are case sensitive", `{"stop":[]}`, `unknown hook event "stop"`},
		{"groups must be an array", `{"Stop":{}}`, "hooks.Stop must be an array of hook groups"},
		{"10 groups is the limit", `{"Stop":` + groups(10) + `}`, ""},
		{"11 groups is over it", `{"Stop":` + groups(11) + `}`, "hooks.Stop exceeds max 10 groups"},
		{"a group must be an object", `{"Stop":["x"]}`, "hooks.Stop[0]: invalid hook group"},
		{"a group needs a hooks array", `{"Stop":[{"matcher":"m"}]}`, "hooks.Stop[0]: hooks array is required"},
		{"an empty hooks array is the same", `{"Stop":[{"hooks":[]}]}`, "hooks.Stop[0]: hooks array is required"},
		{"the second group is named by its index", `{"Stop":[` + group + `,{"hooks":[]}]}`, "hooks.Stop[1]: hooks array is required"},
		{"a hook's type must be command", `{"Stop":[{"hooks":[{"type":"command","command":"a"},{"type":"http","command":"b"}]}]}`, `hooks.Stop[0].hooks[1]: type must be "command"`},
		{"a hook needs a command", `{"Stop":[{"hooks":[{"type":"command"}]}]}`, "hooks.Stop[0].hooks[0]: command is required"},
		{"the type is checked before the command", `{"Stop":[{"hooks":[{"type":"","command":""}]}]}`, `hooks.Stop[0].hooks[0]: type must be "command"`},
		{"50 groups in all is the limit", `{"PreToolUse":` + groups(10) + `,"PostToolUse":` + groups(10) + `,"Stop":` + groups(10) + `,"Notification":` + groups(10) + `,"SubagentStop":` + groups(10) + `}`, ""},
		{"51 groups in all is over it", `{"PreToolUse":` + groups(10) + `,"PostToolUse":` + groups(10) + `,"Stop":` + groups(10) + `,"Notification":` + groups(10) + `,"SubagentStop":` + groups(10) + `,"StepFailed":` + groups(1) + `}`, "hooks exceed max 50 total groups"},
	} {
		assert.Equal(t, c.want, validateHooks(json.RawMessage(c.in)), c.name)
	}
	// two faults in two events: which is reported depends on the map's order (quirk, pinned as a set)
	got := validateHooks(json.RawMessage(`{"Nope":[],"Stop":{}}`))
	assert.Contains(t, []string{`unknown hook event "Nope"`, "hooks.Stop must be an array of hook groups"}, got)
}

func TestPinWorkflowValidateTemplateRefs(t *testing.T) {
	for _, c := range []struct {
		name         string
		text         string
		index, total int
		want         string
	}{
		{"no templates", "echo hi", 0, 1, ""},
		{"prev_dir on the first step", "cd {{prev_dir}}", 0, 3, "step 0 cannot reference previous step"},
		{"prev_stdout on the first step", "{{prev_stdout}}", 0, 3, "step 0 cannot reference previous step"},
		{"prev_stderr on the first step", "{{prev_stderr}}", 0, 3, "step 0 cannot reference previous step"},
		{"prev_stdout on the second step", "{{prev_stdout}}", 1, 3, ""},
		{"prev_content is not one of the three (quirk): fine on step 0", "{{prev_content}}", 0, 3, ""},
		{"an earlier step", "{{step_0_stdout}}", 1, 3, ""},
		{"the step itself", "{{step_1_stdout}}", 1, 3, "template references invalid step index"},
		{"a later step", "{{step_2_stdout}}", 1, 3, "template references invalid step index"},
		{"beyond the last step", "{{step_5_stdout}}", 9, 3, "template references invalid step index"},
		{"a step number equal to the step count is out of bounds even when it is before the index", "{{step_3_stdout}}", 5, 3, "template references invalid step index"},
		{"the last step referenced by the one after it", "{{step_2_dir}}", 3, 4, ""},
		{"a number too big for an int", "{{step_99999999999999999999_stdout}}", 1, 3, "template references invalid step index"},
		{"two references, the second bad", "{{step_0_stdout}} {{step_4_stdout}}", 2, 3, "template references invalid step index"},
		{"a step reference without the underscore after the number is not one", "{{step_0}}", 1, 3, ""},
	} {
		assert.Equal(t, c.want, validateTemplateRefs(c.text, c.index, c.total), c.name)
	}
}

func TestPinWorkflowStepWarningsAndWithWarnings(t *testing.T) {
	steps := pinRawSteps(t,
		`{"name":"plain","type":"shell","command":"cat {{a_content}}"}`,   // unquoted: fine
		`{"name":"dq","type":"shell","command":"echo \"{{b_content}}\""}`, // inside double quotes
		`{"name":"sq","type":"shell","command":"echo '{{c_content}}'"}`,   // inside single quotes
		`{"name":"agent","type":"agent","prompt":"\"{{d_content}}\""}`,    // not a shell step
		`{"name":`, // unreadable: skipped
		`{"name":"two","type":"shell","command":"a \"{{e_content}}\" {{f_content}} \"{{g_content}}\""}`, // two inside, one outside
	)
	assert.Equal(t, []string{
		`step 1 (dq): {{b_content}} is inside quotes; it is already inserted as one quoted shell word, so remove the quotes around it (or use "$CORAL_PREV_STDOUT")`,
		`step 2 (sq): {{c_content}} is inside quotes; it is already inserted as one quoted shell word, so remove the quotes around it (or use "$CORAL_PREV_STDOUT")`,
		`step 5 (two): {{e_content}} is inside quotes; it is already inserted as one quoted shell word, so remove the quotes around it (or use "$CORAL_PREV_STDOUT")`,
		`step 5 (two): {{g_content}} is inside quotes; it is already inserted as one quoted shell word, so remove the quotes around it (or use "$CORAL_PREV_STDOUT")`,
	}, stepWarnings(steps))
	assert.Nil(t, stepWarnings(nil))

	type answer struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	}
	v := answer{ID: 3, Name: "w"}
	assert.Equal(t, v, withWarnings(v, nil), "no warnings: the answer itself")
	assert.Equal(t, v, withWarnings(v, []string{}), "an empty list is no warnings")
	got, ok := withWarnings(v, []string{"careful"}).(map[string]any)
	require.True(t, ok, "with warnings the answer is a JSON object")
	assert.Equal(t, map[string]any{"id": float64(3), "name": "w", "warnings": []string{"careful"}}, got)
	assert.Equal(t, []int{1, 2}, withWarnings([]int{1, 2}, []string{"x"}), "an answer that is not an object is returned as it was")
	ch := make(chan int)
	assert.Equal(t, ch, withWarnings(ch, []string{"x"}), "an answer that does not marshal is returned as it was")
}

func TestPinWorkflowCanonicalizeRepoPath(t *testing.T) {
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	require.NoError(t, err)
	got, err := canonicalizeRepoPath(dir + string(filepath.Separator) + "." + string(filepath.Separator))
	require.NoError(t, err)
	assert.Equal(t, resolved, got, "cleaned and resolved")

	file := filepath.Join(dir, "f.txt")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))
	_, err = canonicalizeRepoPath(file)
	assert.ErrorIs(t, err, errNotADirectory)
	assert.Equal(t, "repo_path is not a directory", repoPathError(err))

	_, err = canonicalizeRepoPath(filepath.Join(dir, "missing"))
	require.Error(t, err)
	assert.NotErrorIs(t, err, errNotADirectory)
	assert.Equal(t, "repo_path does not exist", repoPathError(err))
	assert.Equal(t, "repo_path does not exist", repoPathError(fmt.Errorf("anything else")))

	if runtime.GOOS != "windows" {
		link := filepath.Join(t.TempDir(), "link")
		require.NoError(t, os.Symlink(dir, link))
		got, err := canonicalizeRepoPath(link)
		require.NoError(t, err)
		assert.Equal(t, resolved, got, "a symlink is resolved to its target")
	}
}

func TestPinWorkflowStepFileType(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, data []byte) string {
		p := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(p, data, 0o600))
		return p
	}
	assert.Equal(t, "text/plain; charset=utf-8", stepFileType(write("notes.zzz", []byte("just words\n"))), "unknown extension, text: plain text")
	assert.Equal(t, "text/plain; charset=utf-8", stepFileType(write("page.zzz", []byte("<!DOCTYPE html><html><body>hi</body></html>"))), "unknown extension, sniffed HTML: shown as plain text")
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00")
	assert.Equal(t, "image/png", stepFileType(write("img.zzz", png)), "unknown extension, binary: the sniffed type")
	assert.Equal(t, "text/plain; charset=utf-8", stepFileType(write("empty.zzz", nil)), "an empty file is text")
	// a known extension is trusted over the content
	assert.Equal(t, stepFileType(write("a.png", []byte("not a png"))), stepFileType(write("b.png", png)))
	assert.NotEqual(t, "text/plain; charset=utf-8", stepFileType(write("c.png", []byte("not a png"))))
	// a file that cannot be opened
	assert.Equal(t, stepFileType(filepath.Join(dir, "missing.zzz")), stepFileType(filepath.Join(dir, "missing2.zzz")))
	assert.NotEqual(t, "text/plain; charset=utf-8", stepFileType(filepath.Join(dir, "missing.zzz")))
}
