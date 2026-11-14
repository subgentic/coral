package routes

import "github.com/subgentic/coral/internal/board"

// The for-review events of the Hub's feed (#15996): when an artifact is tagged or untagged "for review", /ws/coral sends the Hub a for_review_events list, each {artifact, tagged}: the artifact's id and
// true or false, nothing else (no name, no text, no board). A frame that cannot carry them all says for_review_gap and the Hub reads the artifacts again. They go to a Hub's feed only (through the tunnel, or
// ?feed=hub), never to a dashboard or an agent's socket, and an old Hub ignores the new keys.

// WireForReviewFeed wakes the feeds as soon as the store makes a for-review event, so the Hub hears of a tag at once and not at the next tick.
func (h *SessionsHandler) WireForReviewFeed(bs *board.Store) {
	if bs != nil {
		bs.SetForReviewNotify(h.kickWS)
	}
}
