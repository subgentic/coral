package store

// Auto-sync of edits made in Dropbox (#14714, the Operator's #196912: "let's sync it automatically"), under Security Reviewer's conditions 1 to 9:
// the Operator's switch (on unless turned off), a pause with its reason (another account, a disconnect or a re-key: signin; too many promotions
// in an hour: breaker) that only the Operator's Resume lifts, and the breaker's counts.

import (
	"context"
	"errors"
	"time"
)

// Auto-sync's pause reasons and the breaker's limits.
const (
	AutoSyncPausedSignIn  = "signin"
	AutoSyncPausedBreaker = "breaker"

	AutoSyncMaxPerHour    = 10 // promotions in an hour, every document
	AutoSyncMaxDocPerHour = 5  // promotions of one document in an hour
)

// AutoSync reports whether edits made in Dropbox become new versions on their own: on (the Operator's switch) and paused (the reason, ” runs).
func (s *DropboxStore) AutoSync(ctx context.Context) (on bool, paused string, err error) {
	if err := s.ensureRow(ctx); err != nil {
		return false, "", err
	}
	var r struct {
		Off    int    `db:"autosync_off"`
		Paused string `db:"autosync_paused"`
	}
	if err := s.db.GetContext(ctx, &r, "SELECT autosync_off, autosync_paused FROM dropbox_connection WHERE id = 1"); err != nil {
		return false, "", err
	}
	return r.Off == 0, r.Paused, nil
}

// SetAutoSync is the Operator's switch; turning it on also lifts a pause (Resume).
func (s *DropboxStore) SetAutoSync(ctx context.Context, on bool) error {
	if err := s.ensureRow(ctx); err != nil {
		return err
	}
	off := 1
	if on {
		off = 0
	}
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET autosync_off = ?, autosync_paused = CASE WHEN ? = 0 THEN '' ELSE autosync_paused END WHERE id = 1", off, off)
	return err
}

// PauseAutoSync pauses it with a reason; only the Operator's Resume (SetAutoSync on) lifts it.
func (s *DropboxStore) PauseAutoSync(ctx context.Context, reason string) error {
	if reason != AutoSyncPausedSignIn && reason != AutoSyncPausedBreaker {
		return errors.New("not an auto-sync pause reason")
	}
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET autosync_paused = ? WHERE id = 1", reason)
	return err
}

// PromotionsSince counts the edits promoted since a time: every document, and the one document doc.
func (e *DropboxEdits) PromotionsSince(ctx context.Context, since time.Time, doc string) (all, ofDoc int, err error) {
	var r struct {
		All int `db:"all_n"`
		Doc int `db:"doc_n"`
	}
	err = e.db.GetContext(ctx, &r, `SELECT COUNT(*) AS all_n, COALESCE(SUM(CASE WHEN doc_id = ? THEN 1 ELSE 0 END), 0) AS doc_n
		FROM dropbox_edits WHERE state = ? AND decided_at >= ?`, doc, DropboxEditPromoted, since.UTC().Format(ISOFormat)) // decided_at is written in ISOFormat
	return r.All, r.Doc, err
}

// DropboxEditUndone is an edit made in Dropbox that became a version and that the Operator undid: kept with its rev, so the listing never takes
// the same revision again (a newer revision of the file is a new edit).
const DropboxEditUndone = "undone"

// MarkUndone records that the Operator undid the version an edit became.
func (e *DropboxEdits) MarkUndone(ctx context.Context, digest string) (bool, error) {
	res, err := e.db.ExecContext(ctx, "UPDATE dropbox_edits SET state = ? WHERE digest = ? AND state = ?", DropboxEditUndone, digest, DropboxEditPromoted)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// ForgetVersion drops the outbox rows of one document's version without any Dropbox call (an undone edit: the upload worker never sends it
// again, nothing waits for it, and its copy in Dropbox stays as Dropbox's own history). Another document holding the same bytes keeps its rows
// (Security's SHOULD 5 on b11590071).
func (o *DropboxOutbox) ForgetVersion(ctx context.Context, digest, doc string, version int) error {
	_, err := o.db.ExecContext(ctx, "DELETE FROM dropbox_outbox WHERE digest = ? AND doc_id = ? AND version = ?", digest, doc, version)
	return err
}
