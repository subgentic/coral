package agent

import (
	"os"
	"strings"
	"testing"
)

// #17458 (walk 69 H1): the agent's prompt and docs tell it to share a finished page as a file (a phone cannot open the team's folder), and that the page opens as one file.
func TestThePromptAndDocsTellAnAgentToShareItsFinishedPage(t *testing.T) {
	if !strings.Contains(DefaultTaskWorkflowGuidance, "coral-agent artifact upload index.html") {
		t.Error("the agent prompt does not say to share a built page with artifact upload")
	}
	docs, err := os.ReadFile("../../agent_docs/artifacts.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Share the page or app you built", "does NOT load", "phone cannot open"} {
		if !strings.Contains(string(docs), want) {
			t.Errorf("artifacts.md does not say %q", want)
		}
	}
}
