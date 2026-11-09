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
	"log/slog"
	"net/http"
	"time"

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
