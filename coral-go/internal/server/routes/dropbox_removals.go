package routes

// Removals from Dropbox after the Operator deleted an artifact here (#14814 reworked to the Operator's answer 3: deleting a file in Coral deletes its
// Dropbox copy too), under Security Reviewer's conditions on it:
//  1. Only the Operator's own delete queues one (the dashboard, the signed command line, the Hub owner's stamped call: deleteArtifactCore and
//     deleteSeries). An agent's delete, the prune, unlisted cleanup, shared images and any other automatic cleanup keep the Dropbox copy.
//  2. A durable job with a grace: queued in dropbox_removals, run by the backup worker 24 hours later, retried with backoff, reported removed only
//     on Dropbox's per-entry answer. An upload of the same bytes cancels it; so does the object being here again when it is due.
//  3. Many deletes at once (more than 50 in an hour, or a series of more than 10 versions) are held until the Operator confirms in Settings.
//  4. 6a's rules, nothing relaxed and no typed confirm on its own: parent_rev on every delete; a file edited in Dropbox is not forced (listed with
//     Remove anyway); a copy another Coral keeps only in Dropbox, or markers that cannot be read, is left alone (listed with the typed confirm);
//     batches of 100; audit rows with counts and a word only. The local copy is whatever the delete did.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/subgentic/coral/internal/store"
)

const (
	dropboxRemovalsPerPass = 20               // removals tried in one pass
	dropboxSeriesBulk      = 10               // a series delete of more versions than this is held for the Operator
	dropboxRemovalRetryMax = 6 * time.Hour    // the longest wait between tries
	dropboxRemovalRetryMin = 10 * time.Minute // the first wait
)

// noteOperatorDelete queues the Dropbox removal of an artifact the Operator deleted here: only when the backup holds it (done or edited rows of the
// account connected now). name is the file's name, for the Settings list only; bulk is one delete of many files. It never fails the delete.
func noteOperatorDelete(coralDir, digest, name string, bulk bool) {
	b := dropboxBackupFor(coralDir)
	if b == nil || !objectNameRe.MatchString(digest) {
		return
	}
	ctx := context.Background()
	c, err := b.d.store.Get(ctx)
	if err != nil || !c.Connected {
		return // not connected: nothing in this account to remove (a later sign-in starts its own backup)
	}
	rows, err := b.outbox.LedgerOfDigest(ctx, c.AccountID, digest)
	if err != nil || len(rows) == 0 {
		return
	}
	state, err := b.outbox.QueueRemoval(ctx, digest, name, time.Now(), bulk)
	if err != nil {
		slog.Warn("[dropbox] a removal after a delete was not queued; the copy stays in Dropbox")
		return
	}
	slog.Info("[dropbox] a removal after a delete was queued", "state", state)
}

// seriesDeleteIsBulk reports whether a series delete of n versions is one delete of many files (held for the Operator).
func seriesDeleteIsBulk(n int) bool { return n > dropboxSeriesBulk }

// cancelRemovalOnUpload forgets a waiting removal when the same bytes are uploaded again: the file is wanted after all.
func (b *DropboxBackup) cancelRemovalOnUpload(ctx context.Context, digest string) {
	if had, err := b.outbox.CancelRemoval(ctx, digest); err == nil && had {
		slog.Info("[dropbox] a removal was cancelled: the same file was uploaded again")
	}
}

// objectHere reports whether the artifact's bytes are on this computer again (restored or uploaded since the delete).
func (b *DropboxBackup) objectHere(digest string) bool {
	_, err := os.Lstat(filepath.Join(b.coralDir, "artifacts", "objects", digest))
	return err == nil
}

// Removals runs the due removals: at most dropboxRemovalsPerPass, each through 6a's removeDigest with no typed confirm and no Remove anyway, so
// anything 6a would ask the Operator about is parked for Settings instead.
func (b *DropboxBackup) Removals(ctx context.Context) {
	if !b.ready(ctx) {
		return
	}
	now := time.Now()
	due, err := b.outbox.DueRemovals(ctx, now, dropboxRemovalsPerPass)
	if err != nil || len(due) == 0 {
		return
	}
	removed := 0
	for _, r := range due {
		if ctx.Err() != nil {
			return
		}
		if b.objectHere(r.Digest) {
			_, _ = b.outbox.CancelRemoval(ctx, r.Digest)
			continue
		}
		res, code, refusal, err := b.removeDigest(ctx, r.Digest, nil, nil)
		switch {
		case refusal != nil && refusal["code"] == "others_offloaded":
			others, _ := refusal["others"].([]string)
			unknown, _ := refusal["unknown"].(int)
			_ = b.outbox.KeepRemoval(ctx, r.Digest, "others_offloaded", others, unknown)
		case refusal != nil && refusal["code"] == "markers_unreadable":
			_ = b.outbox.KeepRemoval(ctx, r.Digest, "markers_unreadable", nil, 0)
		case refusal != nil || err != nil || code != http.StatusOK:
			_ = b.outbox.RetryRemoval(ctx, r.Digest, now.Add(removalBackoff(r.Attempts))) // not connected, Dropbox unreachable: later
		case len(res.Edited) > 0:
			j, _ := json.Marshal(res.Edited)
			_ = b.outbox.EditedRemoval(ctx, r.Digest, string(j))
			removed += res.Removed
		case res.InProgress || res.Remaining > 0:
			removed += res.Removed
			_ = b.outbox.RetryRemoval(ctx, r.Digest, now.Add(dropboxRemovalRetryMin)) // a job still running, or more paths than one request
		default:
			removed += res.Removed
			_, _ = b.outbox.CancelRemoval(ctx, r.Digest)
			// A delete is not a decision to keep these bytes out (Security's SHOULD 6 on 26b4d8235): the ledger forgets them, so a later upload of the
			// same bytes is backed up as usual. Only the explicit Remove from Dropbox keeps a file out until Send to Dropbox again.
			if res.Removed > 0 { // only what this job removed: an explicit Remove from Dropbox before it keeps its "stays out" rows (Security's INFO on 5690c313f)
				_, _ = b.outbox.Unremove(ctx, r.Digest)
			}
		}
	}
	if removed > 0 {
		_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditRemoval, Count: removed, Reason: "deleted_here"})
	}
}

// removalBackoff doubles the wait from 10 minutes up to 6 hours.
func removalBackoff(attempts int) time.Duration {
	d := dropboxRemovalRetryMin
	for i := 0; i < attempts && d < dropboxRemovalRetryMax; i++ {
		d *= 2
	}
	return min(d, dropboxRemovalRetryMax)
}

// removalView is one row of Settings' list: the file's name, its state and what the Operator can do.
type removalView struct {
	Digest  string          `json:"digest"`
	Name    string          `json:"name"`
	State   string          `json:"state"`
	DueAt   string          `json:"due_at"`
	Reason  string          `json:"reason,omitempty"`
	Others  []string        `json:"others,omitempty"`
	Unknown int             `json:"unknown,omitempty"`
	Edited  []removalEdited `json:"edited,omitempty"`
}

// DropboxRemovals answers GET /api/dropbox/removals: the removals after deletes here, for Settings (the Operator's, on this computer only).
func (h *CloudHandler) DropboxRemovals(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	rows, err := d.backup.outbox.Removals(r.Context(), 200)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the removals")
		return
	}
	counts, err := d.backup.outbox.RemovalCounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the removals")
		return
	}
	out := make([]removalView, 0, len(rows))
	for _, x := range rows {
		v := removalView{Digest: x.Digest, Name: x.Name, State: x.State, DueAt: x.DueAt, Reason: x.Reason, Others: x.OthersList(), Unknown: x.Unknown}
		if x.Edited != "" {
			_ = json.Unmarshal([]byte(x.Edited), &v.Edited)
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"removals": out, "counts": counts, "grace_hours": int(store.DropboxRemovalGrace / time.Hour)})
}

// DropboxCancelRemovals answers POST /api/dropbox/removals/cancel: keep files in Dropbox. Body {"digest": id} for one, or {"state": "waiting" |
// "held"} for all of them (Cancel all, Keep them in Dropbox). The Operator's, on this computer only.
func (h *CloudHandler) DropboxCancelRemovals(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	var in struct {
		Digest string `json:"digest"`
		State  string `json:"state"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := decodeJSONStrict(r, &in); err != nil || (in.Digest == "") == (in.State == "") {
		errBadRequest(w, "name one file (digest) or one state")
		return
	}
	ob := d.backup.outbox
	n := 0
	switch {
	case in.Digest != "":
		if !dropboxDigestRe.MatchString(in.Digest) {
			errBadRequest(w, "not an artifact id")
			return
		}
		had, err := ob.CancelRemoval(r.Context(), in.Digest)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "", "could not change the removals")
			return
		}
		if had {
			n = 1
		}
	case in.State == store.DropboxRemovalWaiting || in.State == store.DropboxRemovalHeld:
		c, err := ob.CancelRemovals(r.Context(), in.State)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "", "could not change the removals")
			return
		}
		n = c
	default:
		errBadRequest(w, "only waiting or held removals are cancelled all at once")
		return
	}
	if n > 0 {
		_ = d.store.AddAudit(r.Context(), store.DropboxAudit{Kind: store.DropboxAuditRemoval, Who: "operator", Count: n, Reason: "kept"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"kept": n})
}

// DropboxConfirmRemovals answers POST /api/dropbox/removals/confirm {"confirm": true}: the held removals go ahead (after the rest of their grace).
func (h *CloudHandler) DropboxConfirmRemovals(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	var in struct {
		Confirm bool `json:"confirm"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := decodeJSONStrict(r, &in); err != nil || !in.Confirm {
		writeError(w, http.StatusBadRequest, "confirm_required", "Removing these files from Dropbox needs your confirm")
		return
	}
	n, err := d.backup.outbox.ConfirmHeld(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not change the removals")
		return
	}
	if n > 0 {
		_ = d.store.AddAudit(r.Context(), store.DropboxAudit{Kind: store.DropboxAuditRemoval, Who: "operator", Count: n, Reason: "confirmed"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"confirmed": n})
}
