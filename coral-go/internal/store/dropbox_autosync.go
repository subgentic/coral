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
