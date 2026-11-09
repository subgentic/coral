package routes

// Dropbox stage 6a, explicit removal (#14814; design v33 §4a and Security's conditions 2a to 2g on the 6 delta). The Operator removes an artifact from
// Dropbox, marks it private (the mark first, then the removal), or deletes the whole backup with Disconnect. Before any removal Coral lists the
// artifact's offload markers: a marker of another Coral means that Coral keeps the file only in Dropbox, so the removal needs the last 4 characters of
// every such Coral's id typed (checked here against this listing, never the page's idea). Only "not found" means no markers; any other answer refuses
// (fail closed). Per-file deletes carry the ledger's rev (parent_rev), so a file edited in Dropbox is refused and reported; "Remove anyway" deletes only
// at the rev the dialog showed. A removed artifact is never sent again. The local copy is never touched. The listing-to-delete race (another Coral
// offloading in between) cannot be closed here; parent_rev keeps an edited file, and 6b's fetch-back checks markers again.

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/store"
)

const (
	dropboxRemoveMax   = 2000 // paths one request removes; more remain for another (Security's 2c)
	dropboxRemoveBatch = 100
)

// dropboxListPagesMax bounds delete-all's listing of /v1; a listing cut off with more to read refuses (Security's SHOULD 4 on cb3ff32dd). A var so a
// test can make it small.
var dropboxListPagesMax = 1000

var (
	dropboxDigestRe   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	dropboxServerIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

	errMarkersUnreadable = errors.New("the offload markers could not be read")
	errNotConnected      = errors.New("not connected to Dropbox")
)

// markerHolders lists the other Corals that keep digest only in Dropbox: their server ids, and how many marker names are not a server id at all.
func (b *DropboxBackup) markerHolders(ctx context.Context, cl *dropbox.Client, access, digest string) (others []string, unknown int, err error) {
	names, err := cl.ListNames(ctx, access, "/v1/offloaded/"+digest[:3]+"/"+digest)
	if errors.Is(err, dropbox.ErrNotFound) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, errMarkersUnreadable // fail closed (Security's 2a)
	}
	mine, _ := b.d.store.ServerID(ctx)
	for _, n := range names {
		switch {
		case n == mine:
		case dropboxServerIDRe.MatchString(n):
			others = append(others, n)
		default:
			unknown++
		}
	}
	return others, unknown, nil
}

// typedCovers reports whether the typed values name every other Coral by the last 4 characters of its id, and "unknown" when a marker name was not
// an id (Security's 1a and 2a): one typed value for each, compared exactly.
func typedCovers(typed, others []string, unknown int) bool {
	have := map[string]bool{}
	for _, t := range typed {
		have[t] = true
	}
	for _, o := range others {
		if !have[o[len(o)-4:]] {
			return false
		}
	}
	return unknown == 0 || have["unknown"]
}

func last4(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, id[len(id)-4:])
	}
	return out
}

// dropboxAccess is the connected account and a fresh access token, or why not.
func (b *DropboxBackup) dropboxAccess(ctx context.Context) (*dropbox.Client, string, string, error) {
	c, err := b.d.store.Get(ctx)
	if err != nil || !c.Connected || c.AccountID == "" || b.d.appKey() == "" || b.d.looksLikeCopy(ctx) {
		return nil, "", "", errNotConnected
	}
	refresh, err := b.d.store.RefreshToken(ctx)
	if err != nil {
		return nil, "", "", errNotConnected
	}
	cl := b.d.client(b.d.appKey())
	access, err := cl.Refresh(ctx, refresh)
	if errors.Is(err, dropbox.ErrInvalidGrant) {
		_ = b.d.store.SetState(ctx, store.DropboxStateReconnect)
	}
	if err != nil {
		return nil, "", "", errNotConnected
	}
	return cl, access, c.AccountID, nil
}

// removalResult is what a removal did: files removed, files edited in Dropbox (with the rev Dropbox has now, for "Remove anyway"), whether a
// delete job is still running, and how many paths remain for another request.
type removalResult struct {
	Removed    int             `json:"removed"`
	Edited     []removalEdited `json:"edited,omitempty"`
	InProgress bool            `json:"in_progress,omitempty"`
	Remaining  int             `json:"remaining,omitempty"`
}

type removalEdited struct {
	Path string `json:"path"` // the ledger's own path (a Coral-made string of ids)
	Rev  string `json:"rev"`  // the rev Dropbox has now: "Remove anyway" sends it back and deletes at it only
}

// removeDigest removes digest's files from Dropbox after the marker check. anyway maps a ledger path to the rev the dialog showed.
func (b *DropboxBackup) removeDigest(ctx context.Context, digest string, typed []string, anyway map[string]string) (removalResult, int, map[string]any, error) {
	var res removalResult
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		return res, http.StatusConflict, map[string]any{"code": "not_connected", "error": "Connect Dropbox first"}, err
	}
	rows, err := b.outbox.LedgerOfDigest(ctx, account, digest)
	if err != nil {
		return res, http.StatusInternalServerError, nil, err
	}
	if len(rows) == 0 {
		_, _ = b.outbox.RemoveQueued(ctx, digest) // nothing in Dropbox yet: only what still waits, so it is not sent
		return res, http.StatusOK, nil, nil
	}
	others, unknown, err := b.markerHolders(ctx, cl, access, digest)
	if err != nil {
		return res, http.StatusServiceUnavailable, map[string]any{"code": "markers_unreadable", "error": "Coral could not check whether another Coral keeps this file only in Dropbox. Try again."}, err
	}
	if (len(others) > 0 || unknown > 0) && !typedCovers(typed, others, unknown) {
		return res, http.StatusConflict, map[string]any{"code": "others_offloaded", "others": last4(others), "unknown": unknown,
			"error": "Another Coral keeps this file only in Dropbox. Removing it loses it there. Type the last 4 characters of each to go on."}, nil
	}
	// The checks passed: only now is what still waits for this artifact taken out of the backup (Security's SHOULD 5 on cb3ff32dd), so a
	// refused removal leaves the backup as it was.
	_, _ = b.outbox.RemoveQueued(ctx, digest)
	if len(rows) > dropboxRemoveMax {
		res.Remaining = len(rows) - dropboxRemoveMax
		rows = rows[:dropboxRemoveMax]
	}
	byPath := map[string]store.PathRow{}
	for _, r := range rows {
		byPath[r.Path] = r
	}
	for start := 0; start < len(rows); start += dropboxRemoveBatch {
		batch := rows[start:min(start+dropboxRemoveBatch, len(rows))]
		dels := make([]dropbox.Delete, len(batch))
		for i, r := range batch {
			rev := r.Rev
			if a := anyway[r.Path]; a != "" {
				rev = a // the rev the dialog showed: a later change is refused again by Dropbox
			}
			dels[i] = dropbox.Delete{Path: r.Path, Rev: rev}
		}
		outs, done, err := b.runDelete(ctx, cl, access, dels)
		if err != nil {
			return res, http.StatusBadGateway, map[string]any{"code": "dropbox_error", "error": "Dropbox did not take the removal. Try again."}, err
		}
		if !done {
			res.InProgress = true // honest: not done, nothing marked (Security's 2b)
			continue
		}
		for i, o := range outs {
			r := byPath[batch[i].Path]
			switch o {
			case dropbox.DeleteOK, dropbox.DeleteNotFound:
				_ = b.outbox.MarkRemoved(ctx, r.ID)
				res.Removed++
			case dropbox.DeleteRefused:
				cur := ""
				if m, err := cl.Metadata(ctx, access, r.Path); err == nil {
					cur = m.Rev
				}
				res.Edited = append(res.Edited, removalEdited{Path: r.Path, Rev: cur})
			default:
				res.Remaining++
			}
		}
	}
	return res, http.StatusOK, nil, nil
}

// runDelete runs one delete_batch to its end (bounded): the outcomes, and whether the job finished.
func (b *DropboxBackup) runDelete(ctx context.Context, cl *dropbox.Client, access string, dels []dropbox.Delete) ([]dropbox.DeleteOutcome, bool, error) {
	job, outs, err := cl.DeleteBatch(ctx, access, dels)
	if err != nil || job == "" {
		return outs, err == nil, err
	}
	for waited := time.Duration(0); waited < b.retainWait; waited += b.retainPoll {
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-time.After(b.retainPoll):
		}
		done, outs, err := cl.DeleteBatchCheck(ctx, access, job, len(dels))
		if errors.Is(err, dropbox.ErrJobUnknown) {
			return nil, false, err
		}
		if err == nil && done {
			return outs, true, nil
		}
	}
	return nil, false, nil
}

// SetMarkPrivate gives the worker the board's way to mark an artifact private (board.Store.SetArtifactPrivate), for "Mark private" (Security's 2e).
func (b *DropboxBackup) SetMarkPrivate(f func(ctx context.Context, digest string) error) {
	if f != nil {
		b.markPrivate = f
	}
}

// DropboxRemove answers POST /api/dropbox/remove/{digest}: remove the artifact from Dropbox (the Operator's, on this computer only).
func (h *CloudHandler) DropboxRemove(w http.ResponseWriter, r *http.Request) {
	h.removeRoute(w, r, false)
}

// DropboxRemovePrivate answers POST /api/dropbox/private/{digest}: mark the artifact private, then remove it from Dropbox (privacy wins).
func (h *CloudHandler) DropboxRemovePrivate(w http.ResponseWriter, r *http.Request) {
	h.removeRoute(w, r, true)
}

func (h *CloudHandler) removeRoute(w http.ResponseWriter, r *http.Request, private bool) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	digest := chi.URLParam(r, "digest")
	if !dropboxDigestRe.MatchString(digest) {
		errBadRequest(w, "not an artifact id")
		return
	}
	var in struct {
		Confirm bool              `json:"confirm"`
		Typed   []string          `json:"typed"`
		Anyway  map[string]string `json:"anyway"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := decodeJSONStrict(r, &in); err != nil || !in.Confirm {
		writeError(w, http.StatusBadRequest, "confirm_required", "Removing it from Dropbox needs your confirm: it is removed for every Coral that uses this backup")
		return
	}
	b := d.backup
	ctx := r.Context()
	reason := "removed"
	if private {
		reason = "private"
		if b.markPrivate == nil {
			writeError(w, http.StatusNotFound, "not_available", "Marking private is not available here")
			return
		}
		if err := b.markPrivate(ctx, digest); err != nil { // the mark first, never the other order (Security's 2e)
			writeError(w, http.StatusInternalServerError, "", "could not save the private mark: nothing was removed")
			return
		}
	}
	res, code, refusal, err := b.removeDigest(ctx, digest, in.Typed, in.Anyway)
	if refusal != nil || (err != nil && code != http.StatusOK) {
		if refusal == nil {
			refusal = map[string]any{"error": "could not remove it from Dropbox"}
		}
		if private {
			refusal["private"] = true
			refusal["note"] = "It is marked private here; its copy in Dropbox is still there."
		}
		writeJSON(w, code, refusal)
		return
	}
	_ = d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditRemoval, Who: "operator", Count: res.Removed, Reason: reason})
	out := map[string]any{"removed": res.Removed, "in_progress": res.InProgress, "remaining": res.Remaining, "edited": res.Edited}
	if private {
		out["private"] = true
	}
	writeJSON(w, http.StatusOK, out)
}

// deleteBackup is Disconnect's "Delete the Dropbox backup too": it lists /v1 first and counts what is not this computer's ledger at its rev (edited
// in Dropbox, another Coral's, anything a person put there) and which other Corals hold markers; the typed confirm must be the word delete, the
// count when it is not zero, and the last 4 of every other Coral (Security's 1b). Only a finished delete clears the ledger; the caller disconnects
// only then (2b).
func (b *DropboxBackup) deleteBackup(ctx context.Context, typed []string) (int, map[string]any, error) {
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		return http.StatusConflict, map[string]any{"code": "not_connected", "error": "Connect Dropbox first"}, err
	}
	mine, _ := b.d.store.ServerID(ctx)
	foreign, files := 0, 0
	othersSet := map[string]bool{}
	cursor := ""
	complete := false
	for pages := 0; pages < dropboxListPagesMax; pages++ {
		var page dropbox.ListPage
		if cursor == "" {
			page, err = cl.ListFolder(ctx, access, "/v1")
		} else {
			page, err = cl.ListFolderContinue(ctx, access, cursor)
		}
		if errors.Is(err, dropbox.ErrNotFound) && cursor == "" {
			complete = true
			break // nothing backed up
		}
		if err != nil {
			return http.StatusServiceUnavailable, map[string]any{"code": "listing_unreadable", "error": "Coral could not list the backup in Dropbox. Try again."}, err
		}
		for _, e := range page.Entries {
			if e.Tag != "file" {
				continue
			}
			files++
			if strings.HasPrefix(e.PathLower, "/v1/offloaded/") {
				if name := e.PathLower[strings.LastIndex(e.PathLower, "/")+1:]; name != mine {
					othersSet[name] = true
				}
				continue
			}
			row, err := b.outbox.ByPath(ctx, e.PathLower)
			if err != nil || row.AccountID != account || row.Rev != e.Rev || (row.State != store.DropboxOutboxDoneS && row.State != store.DropboxOutboxEdited) {
				foreign++
			}
		}
		cursor = page.Cursor
		if !page.HasMore {
			complete = true
			break
		}
	}
	if !complete { // cut off with more to read: the foreign count would be too low, so nothing is deleted
		return http.StatusServiceUnavailable, map[string]any{"code": "listing_unreadable", "error": "The backup is too big to list in one go. Nothing was deleted."}, nil
	}
	var others []string
	unknown := 0
	for o := range othersSet {
		if dropboxServerIDRe.MatchString(o) {
			others = append(others, o)
		} else {
			unknown++
		}
	}
	have := map[string]bool{}
	for _, t := range typed {
		have[t] = true
	}
	ok := have["delete"] && typedCovers(typed, others, unknown) && (foreign == 0 || have[strconv.Itoa(foreign)])
	if !ok {
		return http.StatusConflict, map[string]any{"code": "confirm_delete_backup", "files": files, "foreign": foreign, "others": last4(others), "unknown": unknown,
			"error": "Deleting the backup removes it for every Coral that uses it. Type delete" + map[bool]string{true: ", the number of files not from this computer,", false: ""}[foreign > 0] + " and the last 4 characters of each other Coral to go on."}, nil
	}
	if files == 0 {
		return http.StatusOK, nil, b.outbox.ClearAll(ctx)
	}
	job, outs, err := cl.DeleteFolder(ctx, access, "/v1")
	if err != nil {
		return http.StatusBadGateway, map[string]any{"code": "dropbox_error", "error": "Dropbox did not take the delete. You are still connected; try again."}, err
	}
	done := job == ""
	for waited := time.Duration(0); !done && waited < 4*b.retainWait; waited += b.retainPoll {
		select {
		case <-ctx.Done():
			return http.StatusAccepted, map[string]any{"deleting": true}, ctx.Err()
		case <-time.After(b.retainPoll):
		}
		var fin bool
		fin, outs, err = cl.DeleteBatchCheck(ctx, access, job, 1)
		if err != nil {
			continue
		}
		done = fin
	}
	if !done || len(outs) != 1 || (outs[0] != dropbox.DeleteOK && outs[0] != dropbox.DeleteNotFound) {
		return http.StatusAccepted, map[string]any{"deleting": true, "error": "Dropbox is still deleting the backup. You are still connected; press Disconnect again in a while."}, nil
	}
	_ = b.outbox.ClearAll(ctx)
	_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditRemoval, Who: "operator", Count: files, Reason: "delete_all"})
	return http.StatusOK, nil, nil
}

// DropboxResend answers POST /api/dropbox/resend/{digest}: the Operator's "Send to Dropbox again" for an artifact removed from Dropbox (Security's
// SHOULD 6 on cb3ff32dd). The removed rows are forgotten and the backfill queues it again like any upload (a private mark still keeps it out).
func (h *CloudHandler) DropboxResend(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	digest := chi.URLParam(r, "digest")
	if !dropboxDigestRe.MatchString(digest) {
		errBadRequest(w, "not an artifact id")
		return
	}
	n, err := d.backup.outbox.Unremove(r.Context(), digest)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not change the backup")
		return
	}
	if n > 0 {
		d.backup.Backfill(r.Context())
		d.backup.Nudge()
		_ = d.store.AddAudit(r.Context(), store.DropboxAudit{Kind: store.DropboxAuditRemoval, Who: "operator", Count: n, Reason: "resend"})
	}
	writeJSON(w, http.StatusOK, map[string]any{"queued": n > 0})
}

// DropboxArtifact answers GET /api/dropbox/artifact/{digest}: what the backup holds of one artifact (for its Details block): connected or not,
// files in Dropbox, removed or not. Counts only; the Operator's, on this computer only.
func (h *CloudHandler) DropboxArtifact(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	digest := chi.URLParam(r, "digest")
	if !dropboxDigestRe.MatchString(digest) {
		errBadRequest(w, "not an artifact id")
		return
	}
	c, err := d.store.Get(r.Context())
	if err != nil || !c.Connected {
		writeJSON(w, http.StatusOK, map[string]any{"connected": false})
		return
	}
	in, removed, err := d.backup.outbox.DigestState(r.Context(), c.AccountID, digest)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the backup")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "in_dropbox": in, "removed": removed})
}
