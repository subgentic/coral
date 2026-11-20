package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	setreg "github.com/subgentic/coral/internal/settings"
)

// GdocShareOffMessage is the plain refusal of any Google Doc route while the switch is off (#19996): it names the setting, so the person knows where to turn it on.
const GdocShareOffMessage = "Sharing to Google Docs is turned off. Turn on \"Share to Google Docs (experimental)\" in Settings to use it."

// gdocShareOn reads the switch; an unreadable store counts as off.
func (h *SessionsHandler) gdocShareOn(r *http.Request) bool {
	st, err := h.ss.GetSettings(r.Context())
	return err == nil && setreg.Bool(st, setreg.GdocShare)
}

// requireGdocShare refuses a request while the switch is off, before anything is read or written.
func (h *SessionsHandler) requireGdocShare(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.gdocShareOn(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": GdocShareOffMessage, "code": "gdoc_share_off"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RegisterGdocShare adds the Google Doc share routes (#19996). The status route answers either way; the rest sit behind the switch.
func (h *SessionsHandler) RegisterGdocShare(r chi.Router) {
	r.Get("/api/gdoc/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": h.gdocShareOn(r)})
	})
	r.With(h.requireGdocShare).Post("/api/artifacts/{id}/gdoc/share", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "not built yet (slice 2)", "code": "gdoc_share_todo"})
	})
}
