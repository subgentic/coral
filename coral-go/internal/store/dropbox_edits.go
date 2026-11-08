package store

// Dropbox stage 5a (#14714; design v33 §6 and the 5a delta v2): edits made in Dropbox, held for the Operator. A pending edit's bytes are an object
// with no upload record: it is invisible to every list, search, link, grant, agent and Hub route by construction. The Operator decides once (an
// atomic move from pending to deciding), then the decision is recorded as promoted or separate. Bounds (Security's MUST A): 200 pending edits and
// 1 GiB of their bytes in all.

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jmoiron/sqlx"
)

// Edit states and bounds.
const (
	DropboxEditPending  = "pending"
	DropboxEditDeciding = "deciding"
	DropboxEditPromoted = "promoted"
	DropboxEditSeparate = "separate"

	DropboxEditsMax      = 200
	DropboxEditsMaxBytes = 1 << 30
)

// ErrNotPending is a decision on an edit that is not pending (already decided, being decided, or never seen).
var ErrNotPending = errors.New("no pending Dropbox edit for that document")

// DropboxEdit is one edit made in Dropbox.
type DropboxEdit struct {
	ID         int64  `db:"id" json:"-"`
	AccountID  string `db:"account_id" json:"-"`
	DocID      string `db:"doc_id" json:"doc_id"`
	Version    int    `db:"version" json:"version"`
	OrigDigest string `db:"orig_digest" json:"-"`
	Path       string `db:"path" json:"-"`
	Digest     string `db:"digest" json:"-"`
	MediaType  string `db:"media_type" json:"media_type"`
	Size       int64  `db:"size" json:"size"`
	Rev        string `db:"rev" json:"-"`
	State      string `db:"state" json:"state"`
	SeenAt     string `db:"seen_at" json:"seen_at"`
	Result     string `db:"result" json:"-"`
}

// DropboxEdits is the table.
type DropboxEdits struct{ db *DB }

// NewDropboxEdits makes the store.
func NewDropboxEdits(db *DB) *DropboxEdits { return &DropboxEdits{db: db} }

// Hold records an edit as the document's pending one; a newer edit of a pending document replaces it (repeated edits collapse into the newest).
// A document whose decision is being written is left alone (ErrNotPending).
func (e *DropboxEdits) Hold(ctx context.Context, d DropboxEdit) error {
	return e.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		var state sql.NullString
		err := tx.QueryRowContext(ctx, "SELECT state FROM dropbox_edits WHERE doc_id = ? AND state IN (?, ?)", d.DocID, DropboxEditPending, DropboxEditDeciding).Scan(&state)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			_, err = tx.ExecContext(ctx, `INSERT INTO dropbox_edits (account_id, doc_id, version, orig_digest, path, digest, media_type, size, rev, state, seen_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.AccountID, d.DocID, d.Version, d.OrigDigest, d.Path, d.Digest, d.MediaType, d.Size, d.Rev, DropboxEditPending, nowUTC())
			return err
		case err != nil:
			return err
		case state.String == DropboxEditDeciding:
			return ErrNotPending
		}
		_, err = tx.ExecContext(ctx, `UPDATE dropbox_edits SET version = ?, orig_digest = ?, path = ?, digest = ?, media_type = ?, size = ?, rev = ?, seen_at = ?
			WHERE doc_id = ? AND state = ?`, d.Version, d.OrigDigest, d.Path, d.Digest, d.MediaType, d.Size, d.Rev, nowUTC(), d.DocID, DropboxEditPending)
		return err
	})
}

// Open returns the pending and deciding edits, oldest first.
func (e *DropboxEdits) Open(ctx context.Context) ([]DropboxEdit, error) {
	var out []DropboxEdit
	err := e.db.SelectContext(ctx, &out, `SELECT id, account_id, doc_id, version, orig_digest, path, digest, media_type, size, rev, state, seen_at, result
		FROM dropbox_edits WHERE state IN (?, ?) ORDER BY id`, DropboxEditPending, DropboxEditDeciding)
	return out, err
}

// Get returns a document's open edit.
func (e *DropboxEdits) Get(ctx context.Context, doc string) (DropboxEdit, error) {
	var d DropboxEdit
	err := e.db.GetContext(ctx, &d, `SELECT id, account_id, doc_id, version, orig_digest, path, digest, media_type, size, rev, state, seen_at, result
		FROM dropbox_edits WHERE doc_id = ? AND state IN (?, ?)`, doc, DropboxEditPending, DropboxEditDeciding)
	if errors.Is(err, sql.ErrNoRows) {
		return d, ErrNotPending
	}
	return d, err
}

// IsOpen reports whether a document has a pending edit or one being decided (retention's keepDoc: Security's MUST on #14703).
func (e *DropboxEdits) IsOpen(ctx context.Context, doc string) (bool, error) {
	var n int
	err := e.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM dropbox_edits WHERE doc_id = ? AND state IN (?, ?)", doc, DropboxEditPending, DropboxEditDeciding)
	return n > 0, err
}

// Stats counts the open edits and their bytes (the bounds).
func (e *DropboxEdits) Stats(ctx context.Context) (n int, bytes int64, err error) {
	var r struct {
		N int           `db:"n"`
		B sql.NullInt64 `db:"b"`
	}
	err = e.db.GetContext(ctx, &r, "SELECT COUNT(*) AS n, SUM(size) AS b FROM dropbox_edits WHERE state IN (?, ?)", DropboxEditPending, DropboxEditDeciding)
	return r.N, r.B.Int64, err
}

// Digests are the objects open edits hold: the prune keeps them (Security's MUST, the 5a delta).
func (e *DropboxEdits) Digests(ctx context.Context) (map[string]bool, error) {
	var ds []string
	if err := e.db.SelectContext(ctx, &ds, "SELECT digest FROM dropbox_edits WHERE state IN (?, ?)", DropboxEditPending, DropboxEditDeciding); err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(ds))
	for _, d := range ds {
		out[d] = true
	}
	return out, nil
}

// SeenRev reports whether this rev of a document was already held, whatever became of it: a decided edit is not fetched and held again.
func (e *DropboxEdits) SeenRev(ctx context.Context, doc, rev string) (bool, error) {
	var n int
	err := e.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM dropbox_edits WHERE doc_id = ? AND rev = ?", doc, rev)
	return n > 0, err
}

// Holds reports whether an open edit holds the object digest (the prune's re-check under the object's lock).
func (e *DropboxEdits) Holds(ctx context.Context, digest string) (bool, error) {
	var n int
	err := e.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM dropbox_edits WHERE digest = ? AND state IN (?, ?)", digest, DropboxEditPending, DropboxEditDeciding)
	return n > 0, err
}

// Begin moves a document's pending edit to deciding, once: a second click, or the other button at the same time, gets ErrNotPending.
func (e *DropboxEdits) Begin(ctx context.Context, doc string) (DropboxEdit, error) {
	res, err := e.db.ExecContext(ctx, "UPDATE dropbox_edits SET state = ? WHERE doc_id = ? AND state = ?", DropboxEditDeciding, doc, DropboxEditPending)
	if err != nil {
		return DropboxEdit{}, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return DropboxEdit{}, ErrNotPending
	}
	return e.Get(ctx, doc)
}

// Finish records the decision (promoted or separate, with its result: the version made or the new document id); Abandon puts it back to pending
// when writing it failed.
func (e *DropboxEdits) Finish(ctx context.Context, id int64, state, result string) error {
	if state != DropboxEditPromoted && state != DropboxEditSeparate {
		return errors.New("not a decision")
	}
	_, err := e.db.ExecContext(ctx, "UPDATE dropbox_edits SET state = ?, result = ?, decided_at = ? WHERE id = ? AND state = ?", state, result, nowUTC(), id, DropboxEditDeciding)
	return err
}

// Abandon puts an edit being decided back to pending.
func (e *DropboxEdits) Abandon(ctx context.Context, id int64) error {
	_, err := e.db.ExecContext(ctx, "UPDATE dropbox_edits SET state = ? WHERE id = ? AND state = ?", DropboxEditPending, id, DropboxEditDeciding)
	return err
}
