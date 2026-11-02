package routes

import (
	"encoding/json"
	"io"
	"net/http"
)

// HistoryImportStatus: GET /api/history-import. A brand-new Coral lists only the chats of agents it launched; the history already on the computer waits for the person (#11970).
// "found" counts what was held back, "sources" by CLI, and "ready" says a first pass has finished (until then found may only be unread).
func (h *HistoryHandler) HistoryImportStatus(w http.ResponseWriter, r *http.Request) {
	if refuseUnlessOperator(w, r, "read the chat import") {
		return
	}
	imported, err := h.ss.DecideHistoryImport(r.Context())
	if err != nil {
		errInternalServer(w, "could not read the chat import")
		return
	}
	counts, err := h.ss.UnimportedCounts(r.Context())
	if err != nil {
		errInternalServer(w, "could not count the earlier chats")
		return
	}
	listed, err := h.ss.ListedNotStarted(r.Context())
	if err != nil {
		errInternalServer(w, "could not count the listed chats")
		return
	}
	found := 0
	for _, n := range counts {
		found += n
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"imported": imported, "found": found, "listed": listed, "sources": counts, "ready": !h.indexing()})
}

// ImportEarlierChats: POST /api/history-import. Only the person: it lists every chat of every CLI on this computer. A body {"imported": false} turns it off again (Settings): the chats Coral
// did not start are held back, nothing is deleted from disk. No body is the Import button.
func (h *HistoryHandler) ImportEarlierChats(w http.ResponseWriter, r *http.Request) {
	if refuseUnlessOperator(w, r, "import earlier chats") {
		return
	}
	var body struct {
		Imported *bool `json:"imported"`
	}
	if raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<10)); err == nil && len(raw) > 0 {
		if json.Unmarshal(raw, &body) != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "send {\"imported\": true or false}, or nothing")
			return
		}
	}
	if err := h.ss.SetHistoryImport(r.Context(), body.Imported == nil || *body.Imported); err != nil {
		errInternalServer(w, "could not import the earlier chats")
		return
	}
	if h.indexKick != nil {
		h.indexKick()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
