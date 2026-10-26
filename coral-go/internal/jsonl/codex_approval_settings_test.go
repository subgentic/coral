package jsonl

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestCodex8471ApprovalSettingsReplaceAndReset(t *testing.T) {
	state := codexTurnCache{}
	read := func(line string, policy, reviewer string) {
		t.Helper()
		readCodexApprovalSettings(&state, []byte(line))
		require.Equal(t, policy, state.approvalPolicy)
		require.Equal(t, reviewer, state.approvalsReviewer)
	}
	read(`{"type":"turn_context","payload":{"approval_policy":"on-request","approvals_reviewer":"auto_review"}}`, "on-request", "auto_review")
	read(`{"type":"event_msg","payload":{"type":"agent_message","message":"approvals_reviewer=user"}}`, "on-request", "auto_review")
	read(`{"type":"event_msg","payload":{"type":"task_started"}}`, "", "")
	read(`{"type":"turn_context","payload":{"approval_policy":"on-request","approvals_reviewer":"user"}}`, "on-request", "user")
	read(`{"type":"turn_context","payload":{"approval_policy":"never","approvals_reviewer":"auto_review"}}`, "never", "auto_review")
	read(`{"type":"turn_context","payload":{"approval_policy":"new-policy","approvals_reviewer":"new-reviewer"}}`, "", "")
	read(`{"type":"turn_context","payload":{}}`, "", "")
}
