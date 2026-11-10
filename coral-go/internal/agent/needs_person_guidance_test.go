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
