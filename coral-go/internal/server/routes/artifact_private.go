package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
)

// The manager's private mark on an artifact (#11457): PUT /api/artifacts/{id}/private {"private": true|false} and GET (the mark). A guide never reads a private artifact: the read check answers it as
// missing, and it is left out of every list a guide reads. Only the person at this computer, or through Coral Hub the account it is linked to, may set or clear it: a guide is refused by the guide
// table and the owner check, and an agent's token by the Operator-only rule.
func (h *SessionsHandler) artifactPrivateRoute(w http.ResponseWriter, r *http.Request) {
	if _, guide := guideOf(r); guide {
		errNotFound(w, "not found")
		return
	}
	if cloud.Tunneled(r) {
		if refuseNonOwner(w, r) { // the table's owner route
			return
		}
	} else if refuseNonOperator(w, r, "mark an artifact private to the manager") {
		return
	}
	id := chi.URLParam(r, "id")
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	if !objectHereOrOffloaded(h.cfg.CoralDir(), id) { // a privacy control works on a file kept only in Dropbox too (stage 6b, Security's 3d)
		errNotFound(w, "artifact not found")
		return
	}
	if r.Method == http.MethodGet {
		private, err := h.bs.ArtifactPrivate(r.Context(), id)
		if err != nil {
			errInternalServer(w, "could not read the mark")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "private": private})
		return
	}
	var in struct {
		Private *bool `json:"private"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := decodeJSONStrict(r, &in); err != nil || in.Private == nil {
		errBadRequest(w, `send {"private": true} or {"private": false}`)
		return
	}
	by := privateMarkBy(r)
	if err := h.bs.SetArtifactPrivate(r.Context(), id, *in.Private, by); err != nil {
		errInternalServer(w, "could not save the mark")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "private": *in.Private})
}

// privateMarkBy is who the mark says set it: the owner through Coral Hub, the self-hosted Hub's signed-in owner (a stamped request, #15713; Security's INFO on #15714), or the Operator at this computer.
func privateMarkBy(r *http.Request) string {
	if cloud.Tunneled(r) {
		return "owner through Coral Hub"
	}
	if kind, _ := r.Context().Value(callerKindKey{}).(string); kind == callerHubOwner {
		return "Operator via Hub"
	}
	return "Operator"
}
