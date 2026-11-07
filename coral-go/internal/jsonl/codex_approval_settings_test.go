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

// The live mode of a Codex agent (#14051): the newest turn_context's approval policy and sandbox, as the CLI ran that turn. A task_started does not clear it (the mode is still what it was), a later turn_context
// replaces it, and anything this reader does not know reads as "" so it is never shown as a mode.
func TestCodexLiveModeIsTheNewestTurnContexts(t *testing.T) {
	state := codexTurnCache{}
	read := func(line, approval, sandbox string) {
		t.Helper()
		readCodexApprovalSettings(&state, []byte(line))
		require.Equal(t, approval, state.liveApproval, line)
		require.Equal(t, sandbox, state.liveSandbox, line)
	}
	read(`{"type":"turn_context","payload":{"approval_policy":"never","sandbox_policy":{"type":"danger-full-access"}}}`, "never", "danger-full-access")
	read(`{"type":"event_msg","payload":{"type":"task_started"}}`, "never", "danger-full-access")
	read(`{"type":"turn_context","payload":{"approval_policy":"on-request","sandbox_policy":{"type":"workspace-write","writable_roots":["/x"]}}}`, "on-request", "workspace-write")
	read(`{"type":"turn_context","payload":{"approval_policy":"on-request","sandbox_policy":{"type":"read-only"}}}`, "on-request", "read-only")
	read(`{"type":"turn_context","payload":{"approval_policy":"never","sandbox_policy":{"type":"a-sandbox-from-the-future"}}}`, "never", "")
	read(`{"type":"turn_context","payload":{"approval_policy":"a-policy-from-the-future"}}`, "", "")
	read(`{"type":"turn_context","payload":{"approval_policy":"never","sandbox_policy":{"type":"danger-full-access"}}}`, "never", "danger-full-access")
	read(`{"type":"turn_context","payload":{}}`, "", "")
}
