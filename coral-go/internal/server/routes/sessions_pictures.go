package routes

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/subgentic/coral/internal/board"
)

// Pictures on an agent's saved instructions (#20750, goal #285): images {"instructions": [hex]} on PUT /api/sessions/live/{name}/instructions, the Operator's alone, uploaded with
// POST /api/field-images?scope=instruction. They stay until replaced (an omitted field leaves them, [] clears them, and instructions saved empty take them away); the agent reads them as coral://artifacts lines after
// the instructions at its next start.

// instructionPictures checks the images of an instructions write; it answers the request when one is not allowed.
func (h *SessionsHandler) instructionPictures(w http.ResponseWriter, r *http.Request, sessionID, draft string, in map[string][]string) (map[string][]board.GoalImage, bool) {
	if in == nil {
		return nil, true
	}
	if h.boardHandler == nil || h.boardHandler.bs == nil {
		writeError(w, http.StatusServiceUnavailable, "pictures_unavailable", "pictures are not available here")
		return nil, false
	}
	record := h.boardHandler.recordedFieldImages(r, "", board.FieldImagesSession, sessionID)
	return h.boardHandler.fieldPictures(w, r, "", "instruction", draft, in, record, "instructions")
}

// keepInstructionPictures saves what a write named; false when the save failed (the instructions are saved, #20758).
func (h *SessionsHandler) keepInstructionPictures(ctx context.Context, sessionID string, pictures map[string][]board.GoalImage) bool {
	if len(pictures) == 0 || h.boardHandler == nil || h.boardHandler.bs == nil {
		return true
	}
	if err := h.boardHandler.saveFieldImages(ctx, "", board.FieldImagesSession, sessionID, pictures); err != nil {
		slog.Warn("[sessions] the pictures of an agent's instructions were not kept", "session", sessionID, "error", err)
		return false
	}
	return true
}

func (h *SessionsHandler) instructionImages(ctx context.Context, sessionID string) map[string][]board.GoalImage {
	if h.boardHandler == nil || h.boardHandler.bs == nil {
		return nil
	}
	m, _ := h.boardHandler.bs.FieldImages(ctx, "", board.FieldImagesSession, sessionID)
	return m
}

// withInstructionPictures is an agent's saved instructions followed by one coral://artifacts line per picture, for the prompt it starts with.
func (h *SessionsHandler) withInstructionPictures(ctx context.Context, sessionID, prompt string) string {
	if prompt == "" {
		return prompt
	}
	return prompt + pictureLines(h.instructionImages(ctx, sessionID)["instructions"])
}

// forgetInstructionPictures removes the pictures of an agent that is gone (#20768); the artifacts stay, other records may share them.
func (h *SessionsHandler) forgetInstructionPictures(ctx context.Context, sessionID string) {
	if sessionID == "" || h.boardHandler == nil || h.boardHandler.bs == nil {
		return
	}
	if err := h.boardHandler.bs.DeleteFieldImages(ctx, "", board.FieldImagesSession, sessionID); err != nil {
		slog.Warn("[sessions] an ended agent's instruction pictures were not removed", "session", sessionID, "error", err)
	}
}
