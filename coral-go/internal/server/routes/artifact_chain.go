package routes

import (
	"context"
	"strings"

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

// changesRequestedFileNamed is the stored file of this board that the Operator asked changes on, that the same uploader made, with this name, newest request first: the file a revised upload of that name is the next
// version of (#15115). "" when there is none (the file was decided or replaced, was made by another agent, or has another name).
func (h *SessionsHandler) changesRequestedFileNamed(ctx context.Context, coralDir, boardID, uploader, name string) string {
	if strings.TrimSpace(uploader) == "" || strings.TrimSpace(name) == "" {
		return ""
	}
	reviews, err := h.bs.ArtifactReviews(ctx, boardID)
	if err != nil {
		return ""
	}
	best, bestAt := "", ""
	for hex, rv := range reviews {
		if rv.State != board.ReviewChangesRequested || (best != "" && rv.At <= bestAt) {
			continue
		}
		if !h.chainFileOpen(ctx, boardID, hex) {
			continue
		}
		for _, rec := range recordsOfDigest(coralDir, hex) {
			if rec.rec.Board == boardID && isAgentUploadRecord(rec.rec) && strings.EqualFold(strings.TrimSpace(rec.rec.Uploader), strings.TrimSpace(uploader)) && rec.rec.Name == name {
				best, bestAt = hex, rv.At
				break
			}
		}
	}
	return best
}
