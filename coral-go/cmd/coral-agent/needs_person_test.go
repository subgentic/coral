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

// #11884 (Beta #11837 end-of-pass): what the person asked to see is for the person (the default guidance said "screenshots for a reviewer" are not tagged, and a team read a goal's "for my review" that way); a decision
// only listed in a message is not asked, and no number of it is cited as if the person had seen it; a Deny is final. Said in the docs and in every default prompt.
func TestWhatThePersonAskedToSeeIsTaggedAndADecisionIsAskedAndADenyIsFinal(t *testing.T) {
	srv := realDocsServer(t)
	wants := []string{
		`A file the person asked to see ("for my review", "post it for me", screenshots or a QA report that a goal or task names) is for the person, not for a reviewer: tag it for review.`,
		`A decision you only list in a message, a document or a task ("open decisions #6 and #8") has not been asked: the person sees only what is a question in their Needs you, so ask each decision there, and never cite a decision number the person has not been shown.`,
		"A file the Operator denied is final: do not upload it again, in any wording, unless the Operator asks you to.",
	}
	for _, topic := range []string{"board", "artifacts"} {
		code, out, errOut := runAgentWithToken(t, srv.URL, "docs", topic)
		if code != 0 {
			t.Fatalf("docs %s: exit %d: %s", topic, code, errOut)
		}
		flat := strings.Join(strings.Fields(out), " ")
		for _, w := range wants {
			if !strings.Contains(flat, w) {
				t.Errorf("docs %s lacks %q", topic, w)
			}
		}
	}
	for name, prompt := range map[string]string{"orchestrator system": agent.DefaultOrchestratorSystemPrompt, "worker system": agent.DefaultWorkerSystemPrompt, "orchestrator action": agent.DefaultOrchestratorActionPrompt, "worker action": agent.DefaultWorkerActionPrompt} {
		for _, w := range wants {
			if !strings.Contains(prompt, w) {
				t.Errorf("%s default prompt lacks %q", name, w)
			}
		}
	}
}

// #11884 (A): a goal's named deliverable for the person's review gets a task, or nobody makes it (Beta's team posted its screenshots and QA report only after the person added a task).
func TestTheOrchestratorMakesATaskForWhatAGoalNamesForTheirReview(t *testing.T) {
	const rule = "When a goal's outcome or done-when names something the person is to review (screenshots, a report, a design), make a task for it, with its output tagged for review, before you call the goal done"
	if !strings.Contains(agent.DefaultOrchestratorSystemPrompt, rule) {
		t.Errorf("the orchestrator's default prompt lacks %q", rule)
	}
	srv := realDocsServer(t)
	code, out, errOut := runAgentWithToken(t, srv.URL, "docs", "board")
	if code != 0 || !strings.Contains(strings.Join(strings.Fields(out), " "), rule) {
		t.Errorf("docs board lacks the rule (exit %d): %s", code, errOut)
	}
}
