package routes

// kickFeedForRequestChange puts a change of a session's open request on /ws/coral now rather than at the next tick (#7420). Coral's feed ticks every 5 s; a request that Codex's own reviewer settles
// in about 3 s was therefore still on the row after the tool had run, and the dashboard's hold for such a request (CODEX_REVIEW_HOLD_MS) ended on the stale row. Only the hook events that open a
// request, or that close one this session has open, kick: a tool_use is one per tool call and a stop one per turn, so neither kicks when nothing is open.
func (h *SessionsHandler) kickFeedForRequestChange(sessionID, eventType string) {
	switch eventType {
	case "permission_request":
		h.openRequests.Store(sessionID, true)
		h.kickWS()
	case "request_resolved", "tool_use", "stop", "prompt_submit", "session_reset", "session_end":
		if _, open := h.openRequests.LoadAndDelete(sessionID); open {
			h.kickWS()
		}
	}
}
