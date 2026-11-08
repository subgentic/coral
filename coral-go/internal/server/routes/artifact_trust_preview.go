package routes

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// trustPreviewRoute: GET, PUT and DELETE /api/artifacts/{id}/trust-preview (#14730, design v3, Security's conditions).
//
// The owner trusts ONE exact version of an HTML file (its digest, never its name or series) so the viewer runs its scripts in a sealed frame (a host document with no bridge: no network, no Coral). A
// new version has a new digest and is untrusted again. Trust is kept on this computer (artifact_preview_trust), undone by DELETE, and takes effect at once. Only the owner: a person at this computer or
// the Hub owner's stamped call (humanInputCaller); an agent's token never (the identity census lists the three routes as operator only); through the Hub a grantee, guide or viewer is refused by the owner
// table. The page asks GET and starts scripts only on an explicit {trusted: true}; every refusal and every error means "no scripts". Only an HTML file can be trusted.
func (h *SessionsHandler) trustPreviewRoute(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only the owner of this computer can allow or read scripts in a preview")
		return
	}
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone
		return
	}
	id := chi.URLParam(r, "id")
	if len(id) != 64 || strings.ToLower(id) != id || !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	var meta agentArtifactMeta
	if data, err := readSmallFile(filepath.Join(h.artifactDir(), id+".json"), 64<<10); err != nil || json.Unmarshal(data, &meta) != nil {
		errNotFound(w, "artifact not found")
		return
	}
	if !trustableMediaType(meta.MediaType) {
		if r.Method == http.MethodGet { // reading is never an error for a file that cannot run scripts: it is simply not trusted (the page then shows the inert preview)
			writeJSON(w, http.StatusOK, map[string]any{"id": id, "trusted": false})
			return
		}
		writeError(w, http.StatusUnsupportedMediaType, "not_html", "only an HTML file can run scripts in its preview")
		return
	}
	switch r.Method {
	case http.MethodGet:
		var n int
		if err := h.db.GetContext(r.Context(), &n, "SELECT COUNT(*) FROM artifact_preview_trust WHERE hex = ?", id); err != nil {
			errInternalServer(w, "could not read the trust record")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "trusted": n > 0})
		return
	case http.MethodDelete:
		if _, err := h.db.ExecContext(r.Context(), "DELETE FROM artifact_preview_trust WHERE hex = ?", id); err != nil {
			errInternalServer(w, "could not turn scripts off")
			return
		}
	default:
		if _, err := h.db.ExecContext(r.Context(), "INSERT INTO artifact_preview_trust (hex, trusted_at) VALUES (?, ?) ON CONFLICT(hex) DO NOTHING", id, time.Now().UTC().Format(time.RFC3339)); err != nil {
			errInternalServer(w, "could not record the trust")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "trusted": r.Method != http.MethodDelete})
}

// trustableMediaType: only HTML is ever run (an SVG, a PDF or a script file is not).
func trustableMediaType(mt string) bool {
	mt = strings.ToLower(strings.TrimSpace(strings.SplitN(mt, ";", 2)[0]))
	return mt == "text/html" || mt == "application/xhtml+xml"
}
