package main

import (
	"bytes"
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
