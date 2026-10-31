package main

import (
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/agent"
)

// What the person must see, decide or approve reaches their Needs you with no team instruction (#11424): the shipped docs, the upload help and the default prompts every team's agents start with all say how, in the
// same words. A change to one that drops it fails here.
func TestNeedsPersonIsInTheDocsAndTheHelp(t *testing.T) {
	srv := realDocsServer(t)
	for _, tc := range []struct {
		topic string
		wants []string
	}{
		{"board", []string{"When the person must see, decide or approve something", `coral-board post --ask "@Operator <question>"`, "Needs you", `--tag "for review"`, "One item per decision, with your recommendation", "comments on a \"for review\" upload reach its uploader", "coral-agent artifact comments <link>", "whether the person commented at this computer's dashboard or through Coral Hub", "a comment by the owner of a team machine is not delivered (several people share one issuer)", `coral-board ask close <message-id> --note "where it was answered"`, "outside Coral without the person's OK", "a person must look at it, decide, or approve it", "(logs, patches, notes, screenshots for a reviewer) is not tagged for review"}},
		{"how-do-i", []string{"Get an agent to put something in front of you", `coral-board post --ask "@Operator <question>"`, "Needs you", "for review", "recommendation", "whether you make them at this computer's dashboard or through Coral Hub", "on a team machine they are not delivered (several people share one issuer)", "outside Coral without your OK", "logs, patches, notes and screenshots meant for other agents are not tagged"}},
		{"artifacts", []string{"a person must look at it, decide, or approve it", "(logs, patches, notes, screenshots for a reviewer) is not tagged for review"}},
	} {
		code, out, errOut := runAgentWithToken(t, srv.URL, "docs", tc.topic)
		if code != 0 {
			t.Fatalf("docs %s: exit %d: %s", tc.topic, code, errOut)
		}
		for _, w := range tc.wants {
			if !strings.Contains(out, w) {
				t.Errorf("docs %s lacks %q", tc.topic, w)
			}
		}
	}
	_, help, helpErr := runAgent(t, srv.URL, "artifact", "upload", "--help")
	if !strings.Contains(strings.Join(strings.Fields(help+helpErr), " "), `"for review" when a person must look at it, decide, or approve it`) || !strings.Contains(strings.Join(strings.Fields(help+helpErr), " "), `a file for other agents or for yourself (logs, patches, notes, screenshots for a reviewer) is not "for review"`) {
		t.Errorf("the upload help does not widen 'for review': %q", help+helpErr)
	}
	for name, prompt := range map[string]string{"orchestrator system": agent.DefaultOrchestratorSystemPrompt, "worker system": agent.DefaultWorkerSystemPrompt, "orchestrator action": agent.DefaultOrchestratorActionPrompt, "worker action": agent.DefaultWorkerActionPrompt} {
		for _, w := range []string{`coral-board post --ask "@Operator <question>"`, "Needs you", `--tag "for review"`, "for other agents or for yourself (logs, patches, notes, screenshots for a reviewer) is not tagged for review", "One item per decision, with your recommendation", "outside Coral without the person's OK"} {
			if !strings.Contains(prompt, w) {
				t.Errorf("%s default prompt lacks %q", name, w)
			}
		}
	}
}
