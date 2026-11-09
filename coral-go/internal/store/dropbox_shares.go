package store

// Share via Dropbox (#14944, design v3): the copies made to share. A row is reserved (preparing) before the copy is made, made live once the copy
// is checked and shared, and set stopping while Stop sharing runs; only a finished stop deletes it. Never the link, never who it was shared with,
// never a token (Security's condition 7). Nothing here calls Dropbox.

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Share states, kinds and audiences, and the hourly bound (Security's condition 10).
const (
	DropboxSharePreparing = "preparing"
	DropboxShareLive      = "live"
	DropboxShareStopping  = "stopping"

	DropboxShareArtifact = "artifact"
	DropboxShareChat     = "chat"

	DropboxSharePeople = "people"
	DropboxShareTeam   = "team"
	DropboxSharePublic = "public"

	DropboxSharesPerHour = 20
)

// ErrShareLimit: more than DropboxSharesPerHour shares were made in the last hour.
var ErrShareLimit = errors.New("20 shares an hour at most; try again later")

// ErrShareNameTaken: another share already uses that path.
var ErrShareNameTaken = errors.New("a share already uses that name")

// DropboxShare is one copy made to share.
type DropboxShare struct {
	ID        int64  `db:"id" json:"id"`
	Path      string `db:"path" json:"path"`
	Digest    string `db:"digest" json:"digest,omitempty"`
	Kind      string `db:"kind" json:"kind"`
	Audience  string `db:"audience" json:"audience"`
	People    int    `db:"people" json:"people,omitempty"`
	AccountID string `db:"account_id" json:"-"`
	FileID    string `db:"file_id" json:"-"`
	Rev       string `db:"rev" json:"-"`
	Hash      string `db:"content_hash" json:"-"`
	State     string `db:"state" json:"state"`
	CreatedAt string `db:"created_at" json:"created_at"`
	ExpiresAt string `db:"expires_at" json:"expires_at,omitempty"`
}

const shareCols = "id, path, digest, kind, audience, people, account_id, file_id, rev, content_hash, state, created_at, expires_at"

// ReserveShare records a share about to be made (preparing), after the hourly bound: every share made in the last hour counts, a stopped one
// too (it is the creating that is bounded). ErrShareNameTaken when the path is in use.
func (o *DropboxOutbox) ReserveShare(ctx context.Context, sh DropboxShare, now time.Time) (int64, error) {
	if sh.Path == "" || sh.AccountID == "" || sh.Hash == "" {
		return 0, errors.New("a share needs a path, an account and the content hash its copy must have")
	}
	if sh.Kind != DropboxShareArtifact && sh.Kind != DropboxShareChat {
		return 0, errors.New("not a share kind")
	}
	if sh.Audience != DropboxSharePeople && sh.Audience != DropboxShareTeam && sh.Audience != DropboxSharePublic {
		return 0, errors.New("not a share audience")
	}
	tx, err := o.db.BeginTxx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() //nolint:errcheck // a no-op after Commit
	var made int
	if err := tx.GetContext(ctx, &made, "SELECT COUNT(*) FROM dropbox_share_log WHERE at >= ?", ts(now.Add(-time.Hour))); err != nil {
		return 0, err
	}
	if made >= DropboxSharesPerHour {
		return 0, ErrShareLimit
	}
	var taken int
	if err := tx.GetContext(ctx, &taken, "SELECT COUNT(*) FROM dropbox_shares WHERE path = ? COLLATE NOCASE", sh.Path); err != nil {
		return 0, err
	}
	if taken > 0 {
		return 0, ErrShareNameTaken
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO dropbox_shares (path, digest, kind, audience, people, account_id, content_hash, state, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sh.Path, sh.Digest, sh.Kind, sh.Audience, sh.People, sh.AccountID, sh.Hash, DropboxSharePreparing, ts(now), sh.ExpiresAt)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO dropbox_share_log (at) VALUES (?)", ts(now)); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM dropbox_share_log WHERE at < ?", ts(now.Add(-2*time.Hour))); err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

// ShareCopied records the copy's id and rev on a preparing share (so a failure after it still deletes the copy at its rev).
func (o *DropboxOutbox) ShareCopied(ctx context.Context, id int64, fileID, rev string) error {
	return o.oneShareRow(o.db.ExecContext(ctx, "UPDATE dropbox_shares SET file_id = ?, rev = ? WHERE id = ? AND state = ?", fileID, rev, id, DropboxSharePreparing))
}

// ShareLive makes a preparing share live, with its expiry (” never).
func (o *DropboxOutbox) ShareLive(ctx context.Context, id int64, expiresAt string) error {
	return o.oneShareRow(o.db.ExecContext(ctx, "UPDATE dropbox_shares SET state = ?, expires_at = ? WHERE id = ? AND state = ?", DropboxShareLive, expiresAt, id, DropboxSharePreparing))
}

// ShareStopping marks a share as being stopped (from live, or a preparing one being undone).
func (o *DropboxOutbox) ShareStopping(ctx context.Context, id int64) error {
	return o.oneShareRow(o.db.ExecContext(ctx, "UPDATE dropbox_shares SET state = ? WHERE id = ?", DropboxShareStopping, id))
}

// ShareGone deletes a share's row: its link is revoked, its members removed and its copy deleted (or already gone).
func (o *DropboxOutbox) ShareGone(ctx context.Context, id int64) error {
	_, err := o.db.ExecContext(ctx, "DELETE FROM dropbox_shares WHERE id = ?", id)
	return err
}

func (o *DropboxOutbox) oneShareRow(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return sql.ErrNoRows
	}
	return nil
}

// Share is one share by id.
func (o *DropboxOutbox) Share(ctx context.Context, id int64) (DropboxShare, error) {
	var sh DropboxShare
	err := o.db.GetContext(ctx, &sh, "SELECT "+shareCols+" FROM dropbox_shares WHERE id = ?", id)
	return sh, err
}

// Shares lists every share, newest first.
func (o *DropboxOutbox) Shares(ctx context.Context) ([]DropboxShare, error) {
	var out []DropboxShare
	err := o.db.SelectContext(ctx, &out, "SELECT "+shareCols+" FROM dropbox_shares ORDER BY id DESC")
	return out, err
}

// SharesOf lists the live and stopping shares of an artifact's bytes, newest first.
func (o *DropboxOutbox) SharesOf(ctx context.Context, digest string) ([]DropboxShare, error) {
	var out []DropboxShare
	if digest == "" {
		return nil, nil
	}
	err := o.db.SelectContext(ctx, &out, "SELECT "+shareCols+" FROM dropbox_shares WHERE digest = ? AND state <> ? ORDER BY id DESC", digest, DropboxSharePreparing)
	return out, err
}

// SharedCount is how many shares are live or being stopped, or were left preparing: what Disconnect, Rekey and Switch warn about (condition 9).
func (o *DropboxOutbox) SharedCount(ctx context.Context) (int, error) {
	var n int
	err := o.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM dropbox_shares")
	return n, err
}

// StaleShares lists shares a crash or a failure left preparing or stopping since before, for the cleanup to undo.
func (o *DropboxOutbox) StaleShares(ctx context.Context, before time.Time) ([]DropboxShare, error) {
	var out []DropboxShare
	err := o.db.SelectContext(ctx, &out, "SELECT "+shareCols+" FROM dropbox_shares WHERE state IN (?, ?) AND created_at < ? ORDER BY id",
		DropboxSharePreparing, DropboxShareStopping, ts(before))
	return out, err
}

// ForgetShares deletes every share row: the Operator confirmed a Disconnect, Rekey or Switch with files still shared, which leaves those copies
// and links in their Dropbox, theirs to manage there. It returns how many were forgotten.
func (o *DropboxOutbox) ForgetShares(ctx context.Context) (int, error) {
	res, err := o.db.ExecContext(ctx, "DELETE FROM dropbox_shares")
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}
