package routes

import "sync"

// openRequests: the sessions whose own hook opened a request to the user and none has closed it yet, so the event that closes it kicks the feed (#7420). Keyed by session id. A session that is killed
// with a request open never sends the event that closes it, so the entry is dropped when the session is forgotten (agent_exited.go, #7462); a package variable like the other per-session memos of this
// package, so that hook can reach it.
var openRequests sync.Map

// kickFeedForRequestChange puts a change of a session's open request on /ws/coral now rather than at the next tick (#7420). Coral's feed ticks every 5 s; a request that Codex's own reviewer settles
// in about 3 s was therefore still on the row after the tool had run, and the dashboard's hold for such a request (CODEX_REVIEW_HOLD_MS) ended on the stale row. Only the hook events that open a
// request, or that close one this session has open, kick: a tool_use is one per tool call and a stop one per turn, so neither kicks when nothing is open.
func (h *SessionsHandler) kickFeedForRequestChange(sessionID, eventType string) {
	switch eventType {
	case "permission_request":
		openRequests.Store(sessionID, true)
		h.kickWS()
	case "request_resolved", "tool_use", "stop", "prompt_submit", "session_reset", "session_end":
		if _, open := openRequests.LoadAndDelete(sessionID); open {
			h.kickWS()
		}
	}
}
