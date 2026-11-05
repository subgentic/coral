package main

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/agentmodels"
)

// MOCK_AGENT_MODELS=1 (#13180): the reply is one Coral's own parser reads as Claude Code's, with the five models and efforts.
func TestMockAnswersTheModelQueryLikeClaude(t *testing.T) {
	var out bytes.Buffer
	answerModelsQuery(strings.NewReader(`{"type":"control_request","request_id":"coral-models","request":{"subtype":"initialize"}}`+"\n"), &out)
	models, err := agentmodels.ParseClaudeInitialize(&out)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, m := range models {
		names = append(names, m.DisplayName)
		if len(m.Efforts) == 0 {
			t.Errorf("%s has no effort levels", m.DisplayName)
		}
	}
	want := "Fable 5.1,Opus 5.5,Sonnet 5.5,Haiku 5.5"
	if got := strings.Join(names, ","); !strings.Contains(got, want) {
		t.Errorf("models %q lack %q", got, want)
	}
}

// Only the model query's arguments take this path, and only when the variable is on: the default stays the one-shot print.
func TestModelQueryIsOptIn(t *testing.T) {
	q := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"}
	if !isStreamJSONCall(q) {
		t.Error("the query's arguments are not recognised")
	}
	if isStreamJSONCall([]string{"-p", "write a goal"}) || isStreamJSONCall([]string{"--input-format", "stream-json"}) {
		t.Error("an ordinary print call or a stream flag alone must not match")
	}
	t.Setenv("MOCK_AGENT_MODELS", "")
	if modelsQueryEnabled() {
		t.Error("enabled with the variable unset")
	}
	t.Setenv("MOCK_AGENT_MODELS", "1")
	if !modelsQueryEnabled() {
		t.Error("not enabled with MOCK_AGENT_MODELS=1")
	}
}

// runMockQuery starts the test binary as the mock (MOCK_AGENT_TEST_MAIN=1) with the model query's arguments, writes stdin to it and returns what it printed.
func runMockQuery(t *testing.T, modelsOn bool, stdin string) string {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose")
	cmd.Env = append(os.Environ(), "MOCK_AGENT_TEST_MAIN=1", "MOCK_AGENT_MODELS=")
	if modelsOn {
		cmd.Env = append(cmd.Env, "MOCK_AGENT_MODELS=1")
	}
	cmd.Stdin = strings.NewReader(stdin)
	b, err := cmd.Output()
	if err != nil {
		t.Fatalf("mock failed: %v", err)
	}
	return string(b)
}

// The main.go wiring (QA Reviewer 2's SHOULD on #13180): with MOCK_AGENT_MODELS=1 the binary answers the query with models and echoes the request id; without it, the old one-shot reply.
func TestMockBinaryAnswersTheModelQueryOnlyWhenAsked(t *testing.T) {
	req := `{"type":"control_request","request_id":"req-42","request":{"subtype":"initialize"}}` + "\n"
	on := runMockQuery(t, true, req)
	if !strings.Contains(on, `"request_id":"req-42"`) || !strings.Contains(on, "Fable 5.1") || !strings.Contains(on, `"control_response"`) {
		t.Errorf("with MOCK_AGENT_MODELS=1 the reply is not the model list with the request id: %s", on)
	}
	off := runMockQuery(t, false, req)
	if strings.Contains(off, "control_response") || !strings.Contains(off, `"result"`) {
		t.Errorf("without the variable the mock must give its old one-shot reply: %s", off)
	}
}

// Only an initialize control request is answered: another subtype, and a line that is not a control request, get nothing.
func TestMockModelQueryAnswersOnlyInitialize(t *testing.T) {
	other := `{"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}` + "\n" + `{"type":"user","message":"hello"}` + "\n"
	if got := runMockQuery(t, true, other); strings.TrimSpace(got) != "" {
		t.Errorf("a non-initialize request was answered: %s", got)
	}
}
