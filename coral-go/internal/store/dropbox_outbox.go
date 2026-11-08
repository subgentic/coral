package store

// Dropbox stage 4's outbox (#14655; design v33 and the stage 4 delta v2): the files to back up, one row per Dropbox path. Rows are queued by the
// upload hook and the backfill, handed out newest artifact first when due, and finish as done (with Dropbox's file id, rev and content hash), parked
// (conflict, skipped: never handed out again until an explicit retry), or retried later. A local delete cancels the queued rows of that artifact; a
// copy already in Dropbox stays until stage 6's explicit removal.

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Outbox row kinds and states.
const (
	DropboxKindVersion  = "version"   // the artifact's bytes
	DropboxKindItemData = "item_data" // its item_data sidecar

	DropboxOutboxQueued   = "queued"
	DropboxOutboxDoneS    = "done"
	DropboxOutboxConflict = "conflict"
	DropboxOutboxSkipped  = "skipped"
	DropboxOutboxFailed   = "failed"
	DropboxOutboxPrivate  = "private" // the artifact is marked private: parked, never sent (Security's SHOULD 4 on #14691)
)

// DropboxOutboxRow is one file to back up.
type DropboxOutboxRow struct {
	ID         int64  `db:"id"`
	Kind       string `db:"kind"`
	Digest     string `db:"digest"`
	DocID      string `db:"doc_id"`
	Version    int    `db:"version"`
	Path       string `db:"path"`
	ArtifactAt string `db:"artifact_at"`
	Attempts   int    `db:"attempts"`
	SecretFlag bool   `db:"secret_flag"`
}

// DropboxOutboxDone is what Dropbox said about a file it stored.
type DropboxOutboxDone struct {
	FileID      string `db:"file_id"`
	Rev         string `db:"rev"`
	ContentHash string `db:"content_hash"`
}

// DropboxOutboxCounts is the status of the backup: counts and the last time a file was stored. No names or paths.
type DropboxOutboxCounts struct {
	Pending  int    `json:"pending"`
	BackedUp int    `json:"backed_up"`
	Conflict int    `json:"conflict"`
	Skipped  int    `json:"skipped"`
	Failed   int    `json:"failed"`
	Private  int    `json:"private"`
	LastSync string `json:"last_sync"`
}

// DropboxOutbox is the table.
type DropboxOutbox struct{ db *DB }

// NewDropboxOutbox makes the store.
func NewDropboxOutbox(db *DB) *DropboxOutbox { return &DropboxOutbox{db: db} }

// ts is a time as the outbox stores and compares it: RFC 3339 to the second, fixed width, so text order is time order (RFC3339Nano drops
// trailing zeros and would not compare as text).
func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// Enqueue queues r unless its path already has a row, and reports whether it added one.
func (o *DropboxOutbox) Enqueue(ctx context.Context, r DropboxOutboxRow) (bool, error) {
	if r.Kind == "" {
		r.Kind = DropboxKindVersion
	}
	if r.Version < 1 {
		r.Version = 1
	}
	res, err := o.db.ExecContext(ctx, `INSERT OR IGNORE INTO dropbox_outbox (kind, digest, doc_id, version, path, artifact_at, secret_flag, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, r.Kind, r.Digest, r.DocID, r.Version, r.Path, r.ArtifactAt, r.SecretFlag, nowUTC())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// Next hands out up to limit queued rows that are due at now, newest artifact first.
func (o *DropboxOutbox) Next(ctx context.Context, now time.Time, limit int) ([]DropboxOutboxRow, error) {
	var rows []DropboxOutboxRow
	err := o.db.SelectContext(ctx, &rows, `SELECT id, kind, digest, doc_id, version, path, artifact_at, attempts, secret_flag FROM dropbox_outbox
		WHERE state = ? AND next_try_at <= ? ORDER BY artifact_at DESC, id LIMIT ?`, DropboxOutboxQueued, ts(now), limit)
	return rows, err
}

// MarkRetry leaves a row queued until at, counting the attempt.
func (o *DropboxOutbox) MarkRetry(ctx context.Context, id int64, at time.Time) error {
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET attempts = attempts + 1, next_try_at = ? WHERE id = ? AND state = ?", ts(at), id, DropboxOutboxQueued)
	return err
}

// MarkDone records what Dropbox stored.
func (o *DropboxOutbox) MarkDone(ctx context.Context, id int64, fileID, rev, contentHash string) error {
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET state = ?, file_id = ?, rev = ?, content_hash = ?, done_at = ? WHERE id = ?",
		DropboxOutboxDoneS, fileID, rev, contentHash, nowUTC(), id)
	return err
}

// MarkParked parks a row as conflict, skipped or failed: it is not handed out again.
func (o *DropboxOutbox) MarkParked(ctx context.Context, id int64, state string) error {
	switch state {
	case DropboxOutboxConflict, DropboxOutboxSkipped, DropboxOutboxFailed, DropboxOutboxPrivate:
	default:
		return errors.New("not a parked outbox state")
	}
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET state = ? WHERE id = ?", state, id)
	return err
}

// Counts reports the backup's status.
func (o *DropboxOutbox) Counts(ctx context.Context) (DropboxOutboxCounts, error) {
	var c DropboxOutboxCounts
	var rows []struct {
		State string `db:"state"`
		N     int    `db:"n"`
	}
	if err := o.db.SelectContext(ctx, &rows, "SELECT state, COUNT(*) AS n FROM dropbox_outbox GROUP BY state"); err != nil {
		return c, err
	}
	for _, r := range rows {
		switch r.State {
		case DropboxOutboxQueued:
			c.Pending = r.N
		case DropboxOutboxDoneS:
			c.BackedUp = r.N
		case DropboxOutboxConflict:
			c.Conflict = r.N
		case DropboxOutboxSkipped:
			c.Skipped = r.N
		case DropboxOutboxFailed:
			c.Failed = r.N
		case DropboxOutboxPrivate:
			c.Private = r.N
		}
	}
	var last sql.NullString
	if err := o.db.GetContext(ctx, &last, "SELECT MAX(done_at) FROM dropbox_outbox WHERE state = ?", DropboxOutboxDoneS); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return c, err
	}
	c.LastSync = last.String
	return c, nil
}

// Done is what Dropbox said about the file at path, when it is backed up.
func (o *DropboxOutbox) Done(ctx context.Context, path string) (DropboxOutboxDone, error) {
	var d DropboxOutboxDone
	var r struct {
		F sql.NullString `db:"file_id"`
		R sql.NullString `db:"rev"`
		H sql.NullString `db:"content_hash"`
	}
	err := o.db.GetContext(ctx, &r, "SELECT file_id, rev, content_hash FROM dropbox_outbox WHERE path = ? AND state = ?", path, DropboxOutboxDoneS)
	d.FileID, d.Rev, d.ContentHash = r.F.String, r.R.String, r.H.String
	return d, err
}

// CancelDigest removes the queued rows of an artifact the person deleted (Security's change b), and reports how many. Rows already done stay.
func (o *DropboxOutbox) CancelDigest(ctx context.Context, digest string) (int, error) {
	res, err := o.db.ExecContext(ctx, "DELETE FROM dropbox_outbox WHERE digest = ? AND state = ?", digest, DropboxOutboxQueued)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// MarkSecret records that a queued file matched a secret shape (the row shows the flag; the hit itself is never stored).
func (o *DropboxOutbox) MarkSecret(ctx context.Context, id int64) error {
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET secret_flag = 1 WHERE id = ?", id)
	return err
}

// DB is the database (for a caller that reads the outbox alongside other tables).
func (o *DropboxOutbox) DB() *DB { return o.db }
