package jsonl

import (
	"bytes"
	"encoding/json"
)

// ReadCodexApprovalSettings reads the CLI's effective settings for its current
// turn, including global config and command-line overrides. Launch flags alone
// cannot tell whether the user's Codex config selected automatic review.
func (r *SessionReader) ReadCodexApprovalSettings(sessionID, workingDir string) (policy, reviewer string) {
	r.ReadCodexTurn(sessionID, workingDir)
	c := r.getOrCreateSessionCache(sessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.codexState.approvalPolicy, c.codexState.approvalsReviewer
}

// ReadCodexLiveMode is the approval policy and the sandbox the agent's newest turn ran with, from its rollout ("" for what is not there or not known). The same read as ReadCodexApprovalSettings:
// incremental and cached per rollout. Display only (#14051): the file is the agent's own, so nothing may be decided from it.
func (r *SessionReader) ReadCodexLiveMode(sessionID, workingDir string) (approval, sandbox string) {
	r.ReadCodexTurn(sessionID, workingDir)
	c := r.getOrCreateSessionCache(sessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.codexState.liveApproval, c.codexState.liveSandbox
}

func readCodexApprovalSettings(state *codexTurnCache, line []byte) {
	if !bytes.Contains(line, []byte(`"turn_context"`)) && !bytes.Contains(line, []byte(`"task_started"`)) && !bytes.Contains(line, []byte(`"user_message"`)) {
		return
	}
	var rec struct {
		Type    string `json:"type"`
		Payload struct {
			Type              string `json:"type"`
			ApprovalPolicy    string `json:"approval_policy"`
			ApprovalsReviewer string `json:"approvals_reviewer"`
			SandboxPolicy     struct {
				Type string `json:"type"`
			} `json:"sandbox_policy"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil {
		return
	}
	if rec.Type == "event_msg" && (rec.Payload.Type == "task_started" || rec.Payload.Type == "user_message") {
		state.approvalPolicy, state.approvalsReviewer = "", ""
	}
	if rec.Type != "turn_context" {
		return
	}
	// The live mode (#14051): what the CLI ran this turn with, replaced by every turn_context and not cleared by a task_started. Display only: this file is written by the agent's own process.
	state.liveApproval, state.liveSandbox = "", ""
	switch rec.Payload.ApprovalPolicy {
	case "never", "on-request", "untrusted", "on-failure":
		state.liveApproval = rec.Payload.ApprovalPolicy
	}
	switch rec.Payload.SandboxPolicy.Type {
	case "danger-full-access", "workspace-write", "read-only", "external-sandbox":
		state.liveSandbox = rec.Payload.SandboxPolicy.Type
	}
	// Replace, never inherit missing/unknown settings from an earlier turn.
	state.approvalPolicy, state.approvalsReviewer = "", ""
	switch rec.Payload.ApprovalPolicy {
	case "never", "on-request", "untrusted", "on-failure":
		state.approvalPolicy = rec.Payload.ApprovalPolicy
	}
	switch rec.Payload.ApprovalsReviewer {
	case "user", "auto_review":
		state.approvalsReviewer = rec.Payload.ApprovalsReviewer
	}
}
