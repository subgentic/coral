package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
)

// starArtifactRoute: PUT /api/artifacts/{id}/star stars an artifact and DELETE unstars it (#9819), a bookmark to find it again: per artifact id and per computer, with no effect on what is
// stored, kept or pruned. The Operator's, from this computer's dashboard or the signed command line; through Coral Hub the owner's alone, like the saved items. Both are idempotent.
func (h *SessionsHandler) starArtifactRoute(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		if refuseNonOwner(w, r) { // the table's owner route (PUT and DELETE /api/artifacts/{hex64}/star)
			return
		}
	} else if refuseNonOperator(w, r, "star or unstar an artifact") {
		return
	}
	id := chi.URLParam(r, "id")
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	var err error
	if r.Method == http.MethodDelete {
		_, err = h.db.ExecContext(r.Context(), "DELETE FROM artifact_stars WHERE hex = ?", id)
	} else {
		if _, statErr := os.Stat(filepath.Join(h.cfg.CoralDir(), "artifacts", "objects", id)); statErr != nil {
			errNotFound(w, "artifact not found")
			return
		}
		_, err = h.db.ExecContext(r.Context(), "INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?) ON CONFLICT(hex) DO NOTHING", id, time.Now().UTC().Format(time.RFC3339))
	}
	if err != nil {
		errInternalServer(w, "could not update the star")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "starred": r.Method != http.MethodDelete})
}
