package agent

import (
	"strings"
	"testing"
)

// #15078 (the Beta walk): the agents asked "approve it or tell me what to change" in prose, so the Operator got a reply box and no Approve button; and an agent that asked again left its older question in Needs you. What every
// agent is told about asking names the two things that avoid both.
func TestNeedsPersonGuidanceTellsAnApprovalAskToUseYesNoAndAReaskToWithdraw(t *testing.T) {
	for _, want := range []string{"--yes-no", "Approve and Deny", "coral-board ask withdraw <message id>"} {
		if !strings.Contains(DefaultNeedsPersonGuidance, want) {
			t.Errorf("the guidance does not say %q", want)
		}
	}
}

// #17711 (walk 81): the Orchestrator approved the task of a draft the person was to review, and then asked about the same file in a plain question, so the person never saw it in Needs you and then saw it twice. Every agent is told a
// deliverable for the person goes to review and is not approved by the Orchestrator, and is not asked again in a plain question.
func TestNeedsPersonGuidanceSaysADeliverableIsReviewedByThePersonNotApprovedByTheOrchestrator(t *testing.T) {
	for _, want := range []string{"Send for review", "the Orchestrator never approves it, or its task, in their place", "not asked about again in a plain question"} {
		if !strings.Contains(DefaultNeedsPersonGuidance, want) {
			t.Errorf("the guidance does not say %q", want)
		}
	}
}
