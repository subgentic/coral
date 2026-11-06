package routes

import "github.com/subgentic/coral/internal/board"

// What the Operator posts to an agent ends the waits that match it (#13947): a comment, a diff or goal comment, a saved edit sent to agents, a decision on a file or a proposal. An agent that waits for the Operator
// (a plain wait, a wait --from Operator, one for its own name) is woken and nudged, as by any other message the Operator posts. The board message route, an ask button and the cross-team routes already did.

// resolveOperatorWaits ends the waits the Operator's message to project matches, in the background.
func (h *BoardHandler) resolveOperatorWaits(project, content string) {
	h.goBG(func() { h.resolveMessageWaits(project, board.OperatorName, content) })
}

// operatorPosted is resolveOperatorWaits for the handlers that post the Operator's message from the sessions side (they reach the board handler the way they reach its notify).
func (h *SessionsHandler) operatorPosted(project, content string) {
	if h.boardHandler != nil {
		h.boardHandler.resolveOperatorWaits(project, content)
	}
}
