package routes

import (
	"log/slog"
	"net/http"

	"github.com/subgentic/coral/internal/board"
)

// The Operator's clean-up of leftover board seats (#11112). Before #11013 an agent could seat itself, or an agent it started, on another team's board, and Coral does not remove those seats itself. Both routes
// are the Operator's alone (operatorOnlyRoutes: an agent's token is refused) and never go through Coral Hub.

// ListForeignSeats is GET /api/board-seats/foreign: every active seat whose session was launched on another board (board.ForeignSeat), by the board it sits on.
func (h *BoardHandler) ListForeignSeats(w http.ResponseWriter, r *http.Request) {
	seats, err := h.bs.ForeignSeats(r.Context())
	if err != nil {
		errInternalServer(w, "could not read the board seats")
		return
	}
	if seats == nil {
		seats = []board.ForeignSeat{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"seats": seats})
}

// RemoveSeat is DELETE /api/board/{project}/seats/{subscriberID}: the Operator takes a seat off a board (the same step as an agent leaving, `coral-board leave`, for any seat). The seat's name and the board's key
// are logged, no text.
func (h *BoardHandler) RemoveSeat(w http.ResponseWriter, r *http.Request) {
	project, subscriber := urlParam(r, "project"), urlParam(r, "subscriberID")
	if subscriber == "" {
		errBadRequest(w, "the seat's name is required")
		return
	}
	found, err := h.bs.Unsubscribe(r.Context(), project, subscriber)
	if err != nil {
		errInternalServer(w, "could not remove the seat")
		return
	}
	if !found {
		errNotFound(w, "that board has no such seat")
		return
	}
	slog.Info("[boards] the Operator removed a seat", "board", project, "seat", subscriber)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "board": project, "subscriber_id": subscriber})
}
