package routes

import (
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// healthItemIDRe is the id the check prints for an item (teamhealth.ItemID).
var healthItemIDRe = regexp.MustCompile(`^[0-9a-f]{8}$`)

// AckHealthItem marks an item of the orchestrator's check handled: it stays off the list until
// its state changes (#4175 step 3). POST /api/board/{project}/health/ack {"item": "<id>"}. The
// team's orchestrator (by its own token) or the Operator only (Security's #4176 rule 19).
func (h *BoardHandler) AckHealthItem(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	who, ok := h.healthAdmin(r, project)
	if !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can acknowledge a health check item")
		return
	}
	var body struct {
		Item string `json:"item"`
	}
	if err := decodeJSON(r, &body); err != nil || !healthItemIDRe.MatchString(body.Item) {
		errBadRequest(w, "item: the 8-character id the check shows as [ack <id>]")
		return
	}
	switch err := h.bs.AckHealthItem(r.Context(), project, body.Item, who, time.Now()); {
	case errors.Is(err, board.ErrNoSuchHealthItem):
		errNotFound(w, err.Error())
	case err != nil:
		errInternalServer(w, err.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "item": body.Item})
	}
}

// ListHealthItems answers GET /api/board/{project}/health/items: the open items of the newest check with their ack ids and the line each was shown as, so an item a check left out (action_list.max_items, or the
// size cap) is still reachable and can be acknowledged. The team's orchestrator (by its own token) or the Operator only, as the ack is (#20495).
func (h *BoardHandler) ListHealthItems(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	if _, ok := h.healthAdmin(r, project); !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can list the open health check items")
		return
	}
	items, err := h.bs.ListOpenHealthItems(r.Context(), project)
	if err != nil {
		errInternalServer(w, "could not read the open health check items")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
