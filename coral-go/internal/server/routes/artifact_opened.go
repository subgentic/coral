package routes

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
)

// POST /api/artifacts/{id}/opened (#13910, the row's "New version v3"): the Operator opened this version of a series, so the newest version they have opened is kept per person, team and series, and a row can say
// "New version" when a later one exists. The Operator's own state, written by the owner alone (through Coral Hub the owner route, class Interact, generation 6). No body is read. What is written comes from the server:
// the series, its board and the version are worked out from the digest's upload record, never from the request; the digest must be a version of a series of a team on this computer (404 otherwise, so the route
// cannot be used to ask whether a digest exists elsewhere); the value only goes up and never above the series' newest version.
func (h *SessionsHandler) openedArtifactRoute(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		if refuseNonOwner(w, r) {
			return
		}
	} else if refuseNonOperator(w, r, "record an opened version") {
		return
	}
	id := chi.URLParam(r, "id")
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	dir := h.cfg.CoralDir()
	sid, n, board, ok := digestSeriesBoard(dir, id)
	if !ok || h.db == nil {
		errNotFound(w, "artifact not found")
		return
	}
	newest := 0
	for _, m := range seriesMembers(dir, sid) {
		if m.N > newest {
			newest = m.N
		}
	}
	if n > newest {
		n = newest // never above what the series really has
	}
	if n < 1 {
		errNotFound(w, "artifact not found")
		return
	}
	person := openedPersonKey(r)
	if _, err := h.db.ExecContext(r.Context(), `INSERT INTO artifact_series_opened (person, board_id, series_id, version, opened_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(person, board_id, series_id) DO UPDATE SET version = MAX(version, excluded.version), opened_at = CASE WHEN excluded.version > version THEN excluded.opened_at ELSE opened_at END`,
		person, board, sid, n, time.Now().UTC().Format(time.RFC3339)); err != nil {
		errInternalServer(w, "could not record the opened version")
		return
	}
	var got int
	if err := h.db.Reader().GetContext(r.Context(), &got, `SELECT version FROM artifact_series_opened WHERE person = ? AND board_id = ? AND series_id = ?`, person, board, sid); err != nil {
		errInternalServer(w, "could not record the opened version")
		return
	}
	if h.bs != nil {
		h.bs.NoteAllArtifactsChanged()
	}
	writeJSON(w, http.StatusOK, map[string]any{"series_id": sid, "opened_version": got})
}

// ownerPersonKey is the person key of the machine's owner on a personal computer: the local dashboard and the Hub owner are the same person, so opening a file at either says the same thing.
const ownerPersonKey = board.OwnerPersonKey

// openedPersonKey is who an opened version belongs to, from the VERIFIED identity only, never a body or a query value. On a personal computer the local dashboard or command line and the Hub owner share one constant key
// (ownerPersonKey). On a team's computer (where the owner check passes for the organisation) it is the Hub user's stable id inside the organisation the machine's own record matched, so two people of one organisation
// each have their own: a request through the Hub with no verified user falls back to the constant key rather than an empty one.
func openedPersonKey(r *http.Request) string {
	if cloud.Tunneled(r) {
		return personKeyOf(hubOwnerRequest(r))
	}
	return ownerPersonKey
}

// personKeyOf is the key of a verified owner request that came through the Hub: the Hub user inside the organisation on a team's computer, the constant owner key otherwise.
func personKeyOf(id callerIdentity) string {
	if id.team && id.hubUserID != "" {
		return "hub:" + id.org + ":" + id.hubUserID
	}
	return ownerPersonKey
}

// digestSeriesBoard is digestSeries with the board the record belongs to and the version of that record: the first upload record of the digest that names a series. Records decide.
func digestSeriesBoard(coralDir, digest string) (seriesID string, n int, board string, ok bool) {
	for _, r := range recordsOfDigest(coralDir, digest) {
		if seriesIDRe.MatchString(r.rec.SeriesID) && strings.TrimSpace(r.rec.Board) != "" {
			return r.rec.SeriesID, r.rec.Version, r.rec.Board, true
		}
	}
	return "", 0, "", false
}
