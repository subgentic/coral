package routes

import (
	"context"
	"database/sql"
	"net/http"
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
	seriesID := ""
	if sid, ok := soleTeamSeriesOf(h.cfg.CoralDir(), id); ok { // the series of the ONE team that holds this digest in a series (#13910); bytes two teams hold in series are two files, and the digest alone is starred or cleared
		seriesID = sid
	}
	person := openedPersonKey(r) // a star is a person's (#13910): the owner key's are the original table's, another person's their own
	if r.Method == http.MethodDelete {
		_, err = h.unstar(r.Context(), person, id)
		if err == nil && seriesID != "" { // the star follows the series, so an unstar clears every version's: the document is no longer pinned. The same bytes in another team's series are another series and stay as they are.
			for _, m := range seriesMembersOfBoard(h.cfg.CoralDir(), seriesID, id) {
				if _, err = h.unstar(r.Context(), person, m.Digest); err != nil {
					break
				}
			}
		}
	} else {
		if !objectHereOrOffloaded(h.cfg.CoralDir(), id) { // Star works on a file kept only in Dropbox too (stage 6b)
			errNotFound(w, "artifact not found")
			return
		}
		_, err = h.star(r.Context(), person, id)
	}
	if err != nil {
		errInternalServer(w, "could not update the star")
		return
	}
	if h.bs != nil {
		h.bs.NoteAllArtifactsChanged()
	}
	out := map[string]any{"id": id, "starred": r.Method != http.MethodDelete}
	if seriesID != "" {
		out["series_id"] = seriesID
	}
	writeJSON(w, http.StatusOK, out)
}

// star records the person's star of a digest (idempotent): the owner key's in artifact_stars, as always, another person's in artifact_person_stars.
func (h *SessionsHandler) star(ctx context.Context, person, id string) (sql.Result, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	if person == ownerPersonKey {
		return h.db.ExecContext(ctx, "INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?) ON CONFLICT(hex) DO NOTHING", id, now)
	}
	return h.db.ExecContext(ctx, "INSERT INTO artifact_person_stars (person, hex, starred_at) VALUES (?, ?, ?) ON CONFLICT(person, hex) DO NOTHING", person, id, now)
}

// unstar removes the person's star of a digest (idempotent), and no one else's.
func (h *SessionsHandler) unstar(ctx context.Context, person, id string) (sql.Result, error) {
	if person == ownerPersonKey {
		return h.db.ExecContext(ctx, "DELETE FROM artifact_stars WHERE hex = ?", id)
	}
	return h.db.ExecContext(ctx, "DELETE FROM artifact_person_stars WHERE person = ? AND hex = ?", person, id)
}
