package routes

import "github.com/subgentic/coral/internal/sessionstate"

// #7896: a PermissionRequest's PostToolUse comes only when its process finishes.
// A completed native outer exec result proves its contained approval is over
// sooner. Deliberately retain the wait before that result, and for any ambiguous
// request/call; screen text and generic transcript activity never release input.
func (h *SessionsHandler) applyCodexCompletedPermission(input *SessionStateInput, sessionID, workingDir string) {
	state := DeriveSessionState(*input)
	if !state.OwnRequest || state.WaitingKind != "permission" {
		return
	}
	var request *StateEvent
	for i := range input.Events {
		e := &input.Events[i]
		switch e.Type {
		case "permission_request":
			// No inference across multiple requests or an unknown inner call set.
			if request != nil || e.Kind != "permission" || len(e.CallIDs) != 1 {
				return
			}
			request = e
		case "tool_use":
			if request != nil && e.ToolUseID == request.CallIDs[0] {
				request = nil
			}
		case "notification":
			if !sessionstate.IsHeldInputSummary(e.Summary) && e.Summary != sessionstate.HeldInputEndedSummary {
				return
			}
		}
	}
	if request == nil {
		return
	}
	at := h.jsonl.ReadCodexCompletedCall(sessionID, workingDir, request.At)
	if at.IsZero() {
		return
	}
	// Resolve only this known inner call, through the existing parallel-safe
	// reducer, without persisting a fabricated PostToolUse or changing its metrics.
	input.Events = append(input.Events, StateEvent{Type: "tool_use", ToolName: request.ToolName, ToolUseID: request.CallIDs[0], At: at})
	input.StalenessSeconds = 0
	input.NotStarted = false
}
