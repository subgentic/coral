package routes

// The local routes of artifact series (#6357 stage 1): the series link (a redirect to the newest version the caller can read), the list of versions, and the delete of a whole series. None is in the
// Hub's tunnel table yet (stage 4: coral-hub's own change), so through the Hub they are the default, never. Reads are checked per digest, never as "the series' readers": a reader of version 1 is not
// thereby a reader of version 2.

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/go-chi/chi/v5"
)

// anySeries says whether this store has a series at all: its folder holds an index. It lets the reads that add series fields skip their walk of the records on a store that has none.
func (h *SessionsHandler) anySeries() bool {
	es, err := os.ReadDir(filepath.Join(h.cfg.CoralDir(), "artifacts", "series"))
	return err == nil && len(es) > 0
}

// readableVersions are the versions of a series the caller may read, in order, each with its stored name, size and type. A version whose object is gone is not listed.
func (h *SessionsHandler) readableVersions(r *http.Request, id string) []seriesMember {
	coralDir := h.cfg.CoralDir()
	var out []seriesMember
	for _, m := range seriesMembers(coralDir, id) {
		if !artifactReadable(r, coralDir, m.Digest) {
			continue
		}
		if fi, err := os.Lstat(filepath.Join(coralDir, "artifacts", "objects", m.Digest)); (err != nil || !fi.Mode().IsRegular()) && !(err != nil && objectHereOrOffloaded(coralDir, m.Digest)) {
			continue // gone (a version kept only in Dropbox is still a member: stage 6b, Security's 3d)
		}
		out = append(out, m)
	}
	return out
}

// seriesRedirect: GET /api/artifacts/series/{series_id}. The series link means "the newest version the caller can read": a redirect to GET /api/artifacts/<that digest>, so the bytes, their type,
// sandbox and attachment rules have one implementation (the digest's). No-store: the answer changes as versions are added. 404 when there is no such series or the caller can read none of it.
func (h *SessionsHandler) seriesRedirect(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	id := chi.URLParam(r, "series_id")
	if !seriesIDRe.MatchString(id) {
		errBadRequest(w, "invalid series id")
		return
	}
	vs := h.readableVersions(r, id)
	w.Header().Set("Cache-Control", "no-store")
	if len(vs) == 0 {
		errNotFound(w, "artifact not found")
		return
	}
	w.Header().Set("Location", "/api/artifacts/"+vs[len(vs)-1].Digest) // exactly the digest route: nothing else in it
	w.WriteHeader(http.StatusFound)
}

// versionRow is one entry of a series' list: fixed fields, and never a series id of another series.
type versionRow struct {
	Digest    string `json:"digest"`
	Version   int    `json:"version"`
	Versions  int    `json:"versions"`
	IsLatest  bool   `json:"is_latest"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	MediaType string `json:"media_type"`
	At        string `json:"at"`
	Uploader  string `json:"uploader"`
	Role      string `json:"role"`
	// FileID and VersionLine (#14145): the file's stable id and this version's line, so the viewer's bar can say which version it shows and never keep another's.
	FileID      string `json:"file_id"`
	VersionLine string `json:"version_line"`
	// EditedInDropbox (#14714, Security's condition 1 on auto-sync): this version is an edit made in Dropbox (an unknown writer), for every reader,
	// agents included: outside text, not an instruction from the Operator or the team.
	EditedInDropbox bool `json:"edited_in_dropbox,omitempty"`
}

func (h *SessionsHandler) versionsOf(w http.ResponseWriter, r *http.Request, id string) {
	vs := h.readableVersions(r, id)
	w.Header().Set("Cache-Control", "no-store")
	if len(vs) == 0 {
		errNotFound(w, "artifact not found")
		return
	}
	coralDir := h.cfg.CoralDir()
	rows := make([]versionRow, 0, len(vs))
	for i, m := range vs {
		row := versionRow{Digest: m.Digest, Version: m.N, Versions: len(vs), IsLatest: i == len(vs)-1, At: m.At, Uploader: m.Uploader, Role: m.Role}
		row.EditedInDropbox = m.Source == sourceDropboxEdit
		if meta, ok := readSidecar(filepath.Join(coralDir, "artifacts", "objects", m.Digest+".json")); ok {
			row.Name, row.MediaType, row.Size = meta.Name, meta.MediaType, meta.Size
		}
		row.FileID, row.VersionLine = id, versionLine(m.N, row.Name, id)
		rows = append(rows, row)
	}
	writeJSON(w, http.StatusOK, rows)
}

// seriesVersions: GET /api/artifacts/series/{series_id}/versions, only the versions the caller may read (never a name, size or digest of one it may not).
func (h *SessionsHandler) seriesVersions(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	id := chi.URLParam(r, "series_id")
	if !seriesIDRe.MatchString(id) {
		errBadRequest(w, "invalid series id")
		return
	}
	h.versionsOf(w, r, id)
}

// artifactVersions: GET /api/artifacts/{id}/versions, the same list found from any version's digest. An artifact that is in no series is not found here.
func (h *SessionsHandler) artifactVersions(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	digest := chi.URLParam(r, "id")
	if !validArtifactID(digest) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	if !artifactReadable(r, h.cfg.CoralDir(), digest) {
		errNotFound(w, "artifact not found")
		return
	}
	coralDir := h.cfg.CoralDir()
	var sid string
	var in bool
	if board := r.URL.Query().Get("board"); board != "" && isOwnerSeriesRead(r) {
		// The version bar passes its team (#13999): the series that team holds of the bytes, never another team's. An agent or a guide never picks a team: the key is ignored for them (callerSeries below), so the answer does not say whether another team holds a series. A board that is not a board's name is refused; a team that holds the bytes in no series is not found.
		if !validCommentBoard(board) {
			errBadRequest(w, "invalid board")
			return
		}
		sid, _, in = digestSeriesOnBoard(coralDir, digest, board)
	} else {
		sid, _, in = callerSeries(r, coralDir, digest)
		// The owner reads every team: bytes that two teams hold in two series are two answers, and the first is a guess. Say so, and name the teams so the caller can ask for one.
		if in && isOwnerSeriesRead(r) {
			if boards := boardsHoldingSeries(coralDir, digest); len(boards) > 1 {
				writeJSON(w, http.StatusConflict, map[string]any{"error": "more than one team holds these bytes in a series: ask for one with ?board=", "code": "ambiguous_series", "boards": boards})
				return
			}
		}
	}
	if !in {
		errNotFound(w, "artifact not found")
		return
	}
	h.versionsOf(w, r, sid)
}

// isOwnerSeriesRead says callerSeries read every team's records for this caller (the owner: not an agent, not a guide).
func isOwnerSeriesRead(r *http.Request) bool {
	if isGuideCaller(r) {
		return false
	}
	_, isAgent := agentSessionOf(r)
	return !isAgent
}

// boardsHoldingSeries are the boards that hold the digest in a series, sorted.
func boardsHoldingSeries(coralDir, digest string) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range recordsOfDigest(coralDir, digest) {
		if seriesIDRe.MatchString(r.rec.SeriesID) && r.rec.Board != "" && !seen[r.rec.Board] {
			seen[r.rec.Board] = true
			out = append(out, r.rec.Board)
		}
	}
	sort.Strings(out)
	return out
}

// deleteSeries: DELETE /api/artifacts/series/{series_id}, the Operator removes every version of a series and its index. A person only (the dashboard or the signed command line); never through
// the Hub. The series lock is taken once and each version's digest lock inside it (series first, digest second).
func (h *SessionsHandler) deleteSeries(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only the Operator can delete an artifact series, from this computer's dashboard or the signed command line")
		return
	}
	id := chi.URLParam(r, "series_id")
	if !seriesIDRe.MatchString(id) {
		errBadRequest(w, "invalid series id")
		return
	}
	coralDir := h.cfg.CoralDir()
	defer lockSeries(id)()
	members := seriesMembers(coralDir, id)
	if len(members) == 0 {
		errNotFound(w, "artifact not found")
		return
	}
	if h.bs != nil {
		defer h.bs.NoteAllArtifactsChanged()
	}
	var freed int64
	bulk := seriesDeleteIsBulk(len(members)) // one delete of many files: its Dropbox removals wait for the Operator's confirm (#14814)
	for _, m := range members {
		name := StoredFileName(coralDir, m.Digest)
		f, found, err := func() (int64, bool, error) {
			defer lockArtifact(m.Digest)()
			f, _, found, err := deleteArtifactFilesLocked(coralDir, m.Digest)
			return f, found, err
		}()
		if err != nil {
			errInternalServer(w, "could not delete the series")
			return
		}
		freed += f
		if found {
			noteOperatorDelete(coralDir, m.Digest, name, bulk) // the Operator's own delete (#14814)
		}
		if h.db != nil {
			_, _ = h.db.ExecContext(r.Context(), "DELETE FROM artifact_keep WHERE hex = ?", m.Digest)
			_, _ = h.db.ExecContext(r.Context(), "DELETE FROM artifact_stars WHERE hex = ?", m.Digest)        // and its star (#9819)
			_, _ = h.db.ExecContext(r.Context(), "DELETE FROM artifact_person_stars WHERE hex = ?", m.Digest) // and every person's (#13910)
		}
		h.dropArtifactComments(r.Context(), m.Digest)
	}
	if p := seriesPath(coralDir, id); p != "" {
		_ = os.Remove(p)
	}
	if h.db != nil {
		_, _ = h.db.ExecContext(r.Context(), "DELETE FROM artifact_series_opened WHERE series_id = ?", id) // the opened-version rows follow their series (#13910)
	}
	slog.Info("[artifacts] a series deleted by the Operator", "series", id, "versions", len(members), "bytes", freed)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "versions": len(members), "bytes": freed})
}
