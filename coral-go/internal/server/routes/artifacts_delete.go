// Deleting artifacts: an object and its files, the locked variant, and the agent-facing delete. Moved out of artifacts.go (#8314), no code changed.

package routes

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/cloud"
)

// deleteArtifactFiles removes an artifact's object, its sidecar and every upload record of it,
// under its digest lock, and keeps the store's size current (#3553). It's the one delete path:
// the Operator's DELETE and #3554's prune both use it. found is false when neither the object
// nor its sidecar existed.
func deleteArtifactFiles(coralDir, id string) (freed int64, records int, found bool, err error) {
	if !objectNameRe.MatchString(id) {
		return 0, 0, false, nil
	}
	// A version of a series is deleted under its series' lock first, the digest's second (#6357), and the series' index forgets it.
	if sid, _, in := digestSeries(coralDir, id); in {
		defer lockSeries(sid)()
		defer lockArtifact(id)()
		freed, records, found, err = deleteArtifactFilesLocked(coralDir, id)
		if found && err == nil {
			forgetVersion(coralDir, sid, id)
		}
		return freed, records, found, err
	}
	defer lockArtifact(id)()
	return deleteArtifactFilesLocked(coralDir, id)
}

// deleteArtifactFilesLocked is deleteArtifactFiles for a caller that already holds id's lock
// (#3554's prune re-checks a candidate under the lock, then deletes it).
func deleteArtifactFilesLocked(coralDir, id string) (freed int64, records int, found bool, err error) {
	if !objectNameRe.MatchString(id) { // an id read from a file or a message is a 64-digit hex name before it is joined onto a folder (#5305)
		return 0, 0, false, errors.New("not an artifact id")
	}
	objectPath := filepath.Join(coralDir, "artifacts", "objects", id)
	info, statErr := os.Stat(objectPath)
	_, sideErr := os.Stat(objectPath + ".json")
	if statErr != nil && sideErr != nil {
		return 0, 0, false, nil
	}
	if statErr == nil {
		if err := os.Remove(objectPath); err != nil {
			return 0, 0, true, err
		}
		freed = info.Size()
		storeFor(coralDir).removed(freed)
	}
	_ = os.Remove(objectPath + ".json")
	if sessions, rerr := os.ReadDir(filepath.Join(coralDir, "artifacts", "uploads")); rerr == nil {
		for _, s := range sessions {
			if up := uploadsDir(coralDir, s.Name()); up != "" && s.IsDir() {
				if os.Remove(filepath.Join(up, id+".json")) == nil {
					records++
				}
			}
		}
	}
	// And its pending receipts (#4440): a file waiting for a message that was never listed.
	for _, path := range pendingRecordPaths(coralDir, id) {
		if os.Remove(path) == nil {
			records++
		}
	}
	// Every board's shared and received rows of it too (#4379): the Operator's delete removes the
	// object and every row that lists it.
	for _, kind := range crossTeamRecordKinds {
		boards, rerr := os.ReadDir(filepath.Join(coralDir, "artifacts", kind))
		if rerr != nil {
			continue
		}
		for _, b := range boards {
			if b.IsDir() && boardDirName.MatchString(b.Name()) && os.Remove(filepath.Join(coralDir, "artifacts", kind, b.Name(), id+".json")) == nil {
				records++
			}
		}
	}
	return freed, records, true, nil
}

// deleteAgentArtifact: DELETE /api/artifacts/{id}, the Operator removes an artifact (#3553,
// from the #3551 audit): its object, its sidecar and every agent's upload record of it. A
// person only: the dashboard on this computer or the operator's signed command line, in every
// mode, and through Coral Hub the machine's OWNER alone (#5575: the stamped owner marker and the
// enrolled label, as hubOwnerRequest; Launch tier, and each delete is recorded in the Operator
// actions with the hub user). An agent's token, a script, an API key and any other Hub caller get
// 403. Links to it in posts and task results stay and show "unavailable".
func (h *SessionsHandler) deleteAgentArtifact(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		if refuseNonOwner(w, r) { // the table's owner route (DELETE /api/artifacts/{hex64}); an owner has a hub user
			return
		}
		owner := hubOwnerRequest(r)
		rec := &statusRecorder{ResponseWriter: w}
		h.deleteArtifactCore(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		recordHubOwnerAction(r.Context(), h.bs, owner, r.Method, r.URL.Path, "", rec.status)
		return
	}
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only the Operator can delete an artifact, from this computer's dashboard or the signed command line")
		return
	}
	h.deleteArtifactCore(w, r)
}

func (h *SessionsHandler) deleteArtifactCore(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	freed, removed, found, err := deleteArtifactFiles(h.cfg.CoralDir(), id)
	if !found {
		errNotFound(w, "artifact not found")
		return
	}
	if err != nil {
		errInternalServer(w, "could not delete the artifact")
		return
	}
	if h.db != nil { // an explicit delete also drops the Operator's keep mark (#3554)
		_, _ = h.db.ExecContext(r.Context(), "DELETE FROM artifact_keep WHERE hex = ?", id)
		_, _ = h.db.ExecContext(r.Context(), "DELETE FROM artifact_stars WHERE hex = ?", id) // and its star (#9819)
	}
	h.dropArtifactComments(r.Context(), id) // and the comments on it (#5176)
	slog.Info("[artifacts] deleted by the Operator", "digest", id, "bytes", freed, "upload_records", removed)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "bytes": freed})
}
