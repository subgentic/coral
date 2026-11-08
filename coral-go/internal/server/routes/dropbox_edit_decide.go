package routes

// Dropbox stage 5a, piece 2 (#14714; the 5a delta v2 and Security's SHOULDs E to G): the Operator's decision on an edit made in Dropbox. Promote
// makes the held bytes the next version of the document's series (written through the editor's own path, under the series lock, as "unknown writer
// in Dropbox", promoted by the Operator, with no review, approval, keep, star, grant or notice state). Keep separate files them as their own
// artifact with a new document id. One decision a held edit: an atomic move to deciding, so a second click or the other button gets 409. Both routes
// are the Operator's on this computer only. A held edit is also an item of Needs you on this computer, never served through Coral Hub.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
)

const (
	sourceDropboxEdit   = "dropbox_edit"              // a record made from an edit in Dropbox, by the Operator's decision
	dropboxEditUploader = "unknown writer in Dropbox" // never the owner: anyone with the Dropbox sign-in could have written it
)

var dropboxDocRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

var errEditNoTeam = errors.New("the file belongs to no team")

// promoteEdit writes the held bytes as the next version of the document's series and returns the version number.
func (b *DropboxBackup) promoteEdit(e store.DropboxEdit) (int, error) {
	orig, _, ok := b.record(e.OrigDigest, e.DocID)
	if !ok {
		return 0, errNoOriginal
	}
	if orig.rec.Board == "" {
		return 0, errEditNoTeam // a file of no team (made before records named one) has no series to join
	}
	plan, err := planNewVersion(b.coralDir, "coral://artifacts/"+e.OrigDigest, orig.rec.Board, e.Digest)
	if err != nil {
		return 0, err
	}
	defer plan.unlock()
	latest := seriesMember{Digest: e.OrigDigest, Session: orig.session, N: 1}
	if len(plan.rows) > 0 {
		latest = plan.rows[len(plan.rows)-1] // the newest version at the moment of the decision (Security's SHOULD E)
	}
	if plan.same != nil {
		return plan.same.N, nil // the edit is already the newest version: nothing to add
	}
	base, _ := readUploadRecord(b.coralDir, latest.Session, latest.Digest)
	name := base.Name
	if name == "" {
		name = orig.rec.Name
	}
	// The held bytes move into the store now (storeArtifactFileAs: fits(), the digest lock), with their record, under the newest version's session.
	if _, _, err := storeArtifactFileAs(b.coralDir, latest.Session, name, e.MediaType, b.heldPath(e.Digest), e.Digest, e.Size, &plan.stamp, 0, func(rec *agentUploadRecord) {
		rec.Board, rec.OwnerKind, rec.OwnerID = orig.rec.Board, base.OwnerKind, base.OwnerID
		rec.Uploader, rec.Role = dropboxEditUploader, ""
		rec.UploadedBy, rec.Source, rec.PromotedBy = "owner", sourceDropboxEdit, "operator"
		rec.TaskID = 0
	}); err != nil {
		return 0, err
	}
	if _, err := plan.commit(b.coralDir, e.Digest, latest.Session); err != nil {
		return 0, err
	}
	return plan.stamp.Version, nil
}

// separateEdit files the held bytes as their own artifact (a new document id) and returns that id.
func (b *DropboxBackup) separateEdit(e store.DropboxEdit) (string, error) {
	orig, _, ok := b.record(e.OrigDigest, e.DocID)
	if !ok {
		return "", errNoOriginal
	}
	if _, _, err := storeArtifactFileAs(b.coralDir, orig.session, separateName(orig.rec.Name), e.MediaType, b.heldPath(e.Digest), e.Digest, e.Size, nil, 0, func(rec *agentUploadRecord) {
		rec.Board, rec.OwnerKind, rec.OwnerID = orig.rec.Board, orig.rec.OwnerKind, orig.rec.OwnerID
		rec.Uploader, rec.Role = dropboxEditUploader, ""
		rec.UploadedBy, rec.Source = "owner", sourceDropboxEdit
		rec.TaskID = 0
	}); err != nil {
		return "", err
	}
	rec, ok := readUploadRecord(b.coralDir, orig.session, e.Digest)
	if !ok {
		return "", errors.New("the separate copy's record could not be read")
	}
	if doc := docIDOf(rec); doc != "" && doc != e.DocID {
		return doc, nil
	}
	return "", errors.New("the separate copy did not get its own document id")
}

// separateName is the name of an edit kept separate: "<name> (edited in Dropbox).<ext>", cleaned and capped like any shown name.
func separateName(name string) string {
	name = cleanValue(name)
	if name == "" {
		name = "file"
	}
	ext := filepath.Ext(name)
	if len(ext) > 12 {
		ext = ""
	}
	return cleanValue(strings.TrimSuffix(name, ext) + " (edited in Dropbox)" + ext)
}

// DropboxPromoteEdit answers POST /api/dropbox/edits/{doc}/promote: use the edit as the next version.
func (h *CloudHandler) DropboxPromoteEdit(w http.ResponseWriter, r *http.Request) {
	h.decideEdit(w, r, true)
}

// DropboxSeparateEdit answers POST /api/dropbox/edits/{doc}/separate: keep the edit as its own artifact.
func (h *CloudHandler) DropboxSeparateEdit(w http.ResponseWriter, r *http.Request) {
	h.decideEdit(w, r, false)
}

func (h *CloudHandler) decideEdit(w http.ResponseWriter, r *http.Request, promote bool) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil || d.backup.edits == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	doc := chi.URLParam(r, "doc")
	if !dropboxDocRe.MatchString(doc) {
		errBadRequest(w, "not a document id")
		return
	}
	b := d.backup
	ctx := r.Context()
	e, err := b.edits.Begin(ctx, doc)
	if errors.Is(err, store.ErrNotPending) {
		writeError(w, http.StatusConflict, "not_pending", "This edit was already decided, or is being decided")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the edit")
		return
	}
	// An edit of an account no longer connected is not decided here (Security's condition c); it is dropped on the next pass.
	if c, cerr := d.store.Get(ctx); cerr != nil || !c.Connected || c.AccountID != e.AccountID {
		_ = b.edits.Abandon(context.WithoutCancel(ctx), e.ID)
		writeError(w, http.StatusConflict, "other_account", "This edit was made in a Dropbox account that is not the one connected now")
		return
	}
	// The held bytes are read again, without following a link, and must still be the digest (conditions a and b).
	if err := b.openHeld(e); err != nil {
		bg := context.WithoutCancel(ctx)
		_ = b.edits.Forget(bg, e.ID)                   // not this edit's bytes any more: it is forgotten,
		b.dropHeld(bg, e.Digest)                       // its file goes (a regular file only),
		_ = d.store.SetListCursor(bg, e.AccountID, "") // and the next listing reads Dropbox again from the start, so it is fetched again
		writeError(w, http.StatusConflict, "held_changed", "The held edit changed on this computer: Coral will fetch it again from Dropbox")
		return
	}
	state, result, out := store.DropboxEditSeparate, "", map[string]any{}
	if promote {
		state = store.DropboxEditPromoted
		var n int
		if n, err = b.promoteEdit(e); err == nil {
			result, out["version"] = fmt.Sprint(n), n
		}
	} else {
		var nd string
		if nd, err = b.separateEdit(e); err == nil {
			result, out["doc_id"] = nd, nd
		}
	}
	if err != nil {
		_ = b.edits.Abandon(context.WithoutCancel(ctx), e.ID) // pending again: nothing was decided
		if errors.Is(err, errEditNoTeam) {
			writeError(w, http.StatusConflict, "no_team", "This file belongs to no team, so it cannot take a new version. Keep the edit separate instead.")
			return
		}
		if errors.Is(err, errStoreFull) {
			writeError(w, http.StatusRequestEntityTooLarge, "store_full", "The artifact store is full: free space or raise the limit (Settings > Storage and cleanup)")
			return
		}
		writeError(w, http.StatusInternalServerError, "", "could not record the decision")
		return
	}
	if err := b.edits.Finish(ctx, e.ID, state, result); err != nil {
		writeError(w, http.StatusInternalServerError, "", "the decision was written but not recorded")
		return
	}
	_ = d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditEdit, Who: "operator", Reason: state}) // no names, ids or bytes
	b.dropHeld(ctx, e.Digest)                                                                                   // in the store now (or the same bytes were already): the held copy goes
	b.sweepHeld(ctx)                                                                                            // and anything else no open edit names
	noteArtifactsChanged()
	out["decision"] = state
	writeJSON(w, http.StatusOK, out)
}

// DropboxEditItems is the held edits as Needs you items for the board's list (this computer only: Security's SHOULD G). Each names Coral's own
// name for the file, never anything from the edited bytes.
func DropboxEditItems(coralDir string) func(r *http.Request) ([]NeedsYouItem, error) {
	return func(r *http.Request) ([]NeedsYouItem, error) {
		if cloud.Tunneled(r) {
			return nil, nil // never through Coral Hub
		}
		b := dropboxBackupFor(coralDir)
		if b == nil || b.edits == nil {
			return nil, nil
		}
		open, err := b.edits.Open(r.Context())
		if err != nil {
			return nil, err
		}
		items := make([]NeedsYouItem, 0, len(open))
		for _, e := range open {
			if e.State != store.DropboxEditPending {
				continue
			}
			name, team := "A file", ""
			if orig, _, ok := b.record(e.OrigDigest, e.DocID); ok {
				name, team = cleanValue(orig.rec.Name), orig.rec.Board
			}
			items = append(items, NeedsYouItem{Kind: "dropbox_edit", ID: "dropbox_edit:" + e.DocID, Line: name + " was edited in Dropbox", Team: team, At: e.SeenAt})
		}
		return items, nil
	}
}

// dropboxAppFolder is the app folder's name in the person's Dropbox (Apps/<it>): Dropbox's own web view of a file is built from it and the
// ledger's own path, never from a name.
const dropboxAppFolder = "coralhub"

// editRows are the held edits for the Settings list: Coral's own name for the file, the edit's size and inspected type, the version Promote would
// make now (Security's SHOULD E: read again when the button is pressed), and the file's place in Dropbox's web view.
func (b *DropboxBackup) editRows(ctx context.Context) []map[string]any {
	open, err := b.edits.Open(ctx)
	if err != nil {
		return nil
	}
	rows := []map[string]any{}
	for _, e := range open {
		if e.State != store.DropboxEditPending {
			continue
		}
		name, next := "A file", 2
		if orig, _, ok := b.record(e.OrigDigest, e.DocID); ok {
			name = cleanValue(orig.rec.Name)
			if id, _, in := digestSeriesOnBoard(b.coralDir, e.OrigDigest, orig.rec.Board); in {
				for _, m := range seriesMembers(b.coralDir, id) {
					next = max(next, m.N+1)
				}
			}
		}
		rows = append(rows, map[string]any{"doc_id": e.DocID, "name": name, "size": e.Size, "media_type": e.MediaType, "seen_at": e.SeenAt, "next_version": next,
			"dropbox_url": "https://www.dropbox.com/home/Apps/" + dropboxAppFolder + e.Path})
	}
	return rows
}
