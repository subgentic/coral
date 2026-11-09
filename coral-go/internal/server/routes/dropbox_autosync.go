package routes

// Auto-sync of edits made in Dropbox (#14714, the Operator's #196912: "let's sync it automatically"). A held edit becomes the next version on its
// own, through the same decision path as the Operator's (decide, with who "dropbox"), under Security Reviewer's conditions:
//   - the Operator's switch, and a pause (another account, a disconnect or a re-key; the breaker) that only Resume lifts (6);
//   - anomalies stay held for the Operator, listed in Settings with Use it as version N and Keep it separate (4): the type by bytes differs from
//     the file's type, or the size jumps over 10 times and over 1 MiB;
//   - the breaker (5): more than 10 promotions in an hour, or 5 of one document, pauses auto-sync and the edit stays held;
//   - the record says unknown writer in Dropbox, uploaded by dropbox, promoted by auto_sync (1); no review, star, keep or grant carries (2).

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/secfile"
	"github.com/subgentic/coral/internal/store"
)

const autoSyncJumpBytes = 1 << 20 // a size jump is an anomaly only above this too

// autoSyncAnomaly says why an edit is held for the Operator instead of promoted (” when it may go).
func autoSyncAnomaly(origType string, origSize int64, e store.DropboxEdit) string {
	if e.MediaType != origType {
		return "type_changed"
	}
	if e.Size > autoSyncJumpBytes && origSize > 0 && e.Size > 10*origSize {
		return "size_jump"
	}
	return ""
}

// autoSyncBucket is auto-sync's own hourly upload bucket: its promotions count like any agent's uploads.
const autoSyncBucket = "dropbox:autosync"

// uploadChecks applies to the held bytes what the upload route applies to an agent's bytes, since the edit never went through that route: the
// hourly cap (auto-sync's own bucket, charged with the size) and the image metadata rule (an image that carries metadata, or that cannot be read
// to strip it, is held: Coral never rewrites bytes that came from Dropbox on its own). The store quota is fits() in the promote path itself. The
// secret flag is not an upload-route step: the backup flags a secret-shaped text when it sends the new version, as for any upload.
func (b *DropboxBackup) uploadChecks(e store.DropboxEdit) string {
	st := storeFor(b.coralDir)
	if ok, _ := st.admitUpload(autoSyncBucket); !ok {
		return "hourly_cap"
	}
	if !st.chargeUpload(autoSyncBucket, e.Size) {
		return "hourly_cap"
	}
	f, err := secfile.OpenNoFollow(b.heldPath(e.Digest), os.O_RDONLY, 0) // no-follow for every read (Security's INFO on b11590071)
	if err != nil {
		return "unreadable"
	}
	data, rerr := io.ReadAll(io.LimitReader(f, dropboxEditMaxSize+1))
	_ = f.Close()
	if rerr != nil {
		return "unreadable"
	}
	if sniffImageFamily(data) != "" {
		if _, changed, cerr := cleanUploadedImage(data); cerr != nil || changed {
			return "image_metadata"
		}
	}
	return ""
}

// autoPromote promotes a newly held edit when auto-sync is on and not paused, the edit is not an anomaly and the breaker allows it. It never fails
// the listing pass: anything it does not do leaves the edit held, as 5a did.
func (b *DropboxBackup) autoPromote(ctx context.Context, e store.DropboxEdit) {
	on, paused, err := b.d.store.AutoSync(ctx)
	if err != nil || !on || paused != "" {
		return
	}
	orig, _, ok := b.record(e.OrigDigest, e.DocID)
	if !ok {
		return
	}
	if why := autoSyncAnomaly(orig.rec.MediaType, orig.rec.Size, e); why != "" {
		slog.Info("[dropbox] an edit made in Dropbox is held for the Operator", "reason", why)
		return
	}
	if why := b.uploadChecks(e); why != "" { // what the upload route applies to bytes (Security's SHOULD 3 on 5d1b9457e): a refusal holds it
		slog.Info("[dropbox] an edit made in Dropbox is held for the Operator", "reason", why)
		return
	}
	all, ofDoc, err := b.edits.PromotionsSince(ctx, time.Now().Add(-time.Hour), e.DocID)
	if err != nil {
		return
	}
	if all >= store.AutoSyncMaxPerHour || ofDoc >= store.AutoSyncMaxDocPerHour {
		_ = b.d.store.PauseAutoSync(ctx, store.AutoSyncPausedBreaker)
		_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditEdit, Count: all, Reason: "auto_paused"})
		slog.Warn("[dropbox] auto-sync paused: too many edits from Dropbox in an hour")
		return
	}
	if _, code, errCode, _ := b.decide(ctx, e.DocID, true, "dropbox"); code != http.StatusOK {
		slog.Info("[dropbox] an edit made in Dropbox was not promoted; it stays held", "code", errCode)
	}
}

// DropboxSetAutoSync answers PUT /api/dropbox/autosync {"on": bool}: the Operator's "Take edits made in Dropbox as new versions" (on this computer
// only). Turning it on also resumes it after a pause; off holds every new edit for the Operator, as 5a did.
func (h *CloudHandler) DropboxSetAutoSync(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	var in struct {
		On *bool `json:"on"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := decodeJSONStrict(r, &in); err != nil || in.On == nil {
		errBadRequest(w, `send {"on": true} or {"on": false}`)
		return
	}
	if err := d.store.SetAutoSync(r.Context(), *in.On); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not save the setting")
		return
	}
	reason := "autosync_off"
	if *in.On {
		reason = "autosync_on"
	}
	_ = d.store.AddAudit(r.Context(), store.DropboxAudit{Kind: store.DropboxAuditSetting, Who: "operator", Reason: reason})
	on, paused, _ := d.store.AutoSync(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"on": on, "paused": paused})
}

// undoEdit removes the version an edit made in Dropbox became, when it is still the newest of its series (Security's conditions 1 to 6 on
// "Undo this edit"): never through the Operator's delete (no Dropbox removal is queued: Dropbox keeps the edit in its history), the bytes go only
// when no other record uses them, the series index forgets it so the version before is the newest again, the outbox forgets its rows without a
// Dropbox call, and the edit is recorded as undone with its rev so the same revision is never taken again.
func (b *DropboxBackup) undoEdit(ctx context.Context, digest string) (int, string, string) {
	sid, _, ok := digestSeries(b.coralDir, digest)
	if !ok {
		return http.StatusNotFound, "not_found", "This file has no versions"
	}
	defer lockSeries(sid)()
	members := seriesMembers(b.coralDir, sid)
	if len(members) < 2 || members[len(members)-1].Digest != digest {
		return http.StatusConflict, "not_newest", "Only the newest version can be undone, and only when it is an edit from Dropbox: a later version was added since"
	}
	last := members[len(members)-1]
	if last.Source != sourceDropboxEdit {
		return http.StatusConflict, "not_an_edit", "This version is not an edit made in Dropbox"
	}
	defer lockArtifact(digest)()
	rec, _ := readUploadRecord(b.coralDir, last.Session, digest) // its document and version, read before the record goes
	if up := uploadsDir(b.coralDir, last.Session); up != "" {
		if err := os.Remove(filepath.Join(up, digest+".json")); err != nil && !os.IsNotExist(err) {
			return http.StatusInternalServerError, "", "could not undo the edit"
		}
	}
	forgetVersion(b.coralDir, sid, digest)
	if len(recordsOfDigest(b.coralDir, digest)) == 0 { // no other record uses these bytes: they go (as a delete's do), under the digest lock
		obj := filepath.Join(b.coralDir, "artifacts", "objects", digest)
		if st, err := os.Lstat(obj); err == nil && st.Mode().IsRegular() && os.Remove(obj) == nil {
			storeFor(b.coralDir).removed(st.Size())
		}
		_ = os.Remove(obj + ".json")
	}
	_ = b.outbox.ForgetVersion(ctx, digest, docIDOf(rec), last.N) // only this document's version: another document with the same bytes keeps its rows
	_, _ = b.edits.MarkUndone(ctx, digest)
	_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditEdit, Who: "operator", Count: 1, Reason: "undone"})
	noteArtifactsChanged()
	return http.StatusOK, "", ""
}

// DropboxUndoEdit answers POST /api/dropbox/undo/{digest} {"confirm": true}: the Operator undoes an edit made in Dropbox that became the newest
// version. A person at this computer only (never through Coral Hub, 403 for an agent's token).
func (h *CloudHandler) DropboxUndoEdit(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only the Operator can undo an edit, from this computer's dashboard")
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil || d.backup.edits == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	digest := chi.URLParam(r, "digest")
	if !dropboxDigestRe.MatchString(digest) {
		errBadRequest(w, "not an artifact id")
		return
	}
	var in struct {
		Confirm bool `json:"confirm"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := decodeJSONStrict(r, &in); err != nil || !in.Confirm {
		writeError(w, http.StatusBadRequest, "confirm_required", "Undoing the edit needs your confirm")
		return
	}
	if code, errCode, msg := d.backup.undoEdit(r.Context(), digest); code != http.StatusOK {
		writeError(w, code, errCode, msg)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"undone": true})
}
