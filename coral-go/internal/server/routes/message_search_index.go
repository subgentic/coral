package routes

import (
	"net/http"
)

// MessageSearchIndexStatus is what Settings shows of the board message search index (#9685): its setting (CORAL_BOARD_SEARCH_INDEX; on unless off), whether this build can have it, its state (off, building,
// ready) and the disk it takes. Read-only, and not served through Coral Hub (cloud class never): it is about this computer's disk.
// GET /api/system/message-search-index
func (h *BoardHandler) MessageSearchIndexStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.bs.MessageSearchIndexStatus(r.Context()))
}
