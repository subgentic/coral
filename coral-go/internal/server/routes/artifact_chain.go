package routes

import (
	"context"

	"github.com/subgentic/coral/internal/board"
)

// chainFileOpen says whether a chain's latest file is still waiting for a decision (#12144): it is tagged for review and the Operator has not approved, denied, ignored or saved it, and it is not already replaced.
// A file whose changes were requested is still the chain's file: the next upload is its next version. A file that cannot be read is not open, so the next upload starts a new series.
func (h *SessionsHandler) chainFileOpen(ctx context.Context, boardID, hex string) bool {
	tags, err := h.bs.ArtifactTags(ctx, boardID)
	if err != nil {
		return false
	}
	have := tags[hex]
	if !hasTag(have, tagForReview) {
		return false
	}
	for _, closed := range []string{board.ReviewApproved, board.ReviewDenied, "ignored", "saved", board.ReviewSuperseded} {
		if hasTag(have, closed) {
			return false
		}
	}
	return true
}
