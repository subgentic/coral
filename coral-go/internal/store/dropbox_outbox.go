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

	// Stage 4b, retention (#14703). The local copy is never touched in any of them.
	DropboxOutboxDeleting    = "deleting"     // a retention delete job is running for the row (delete_job): never put in a second job
	DropboxOutboxRetainedOut = "retained_out" // retention deleted the Dropbox copy
	DropboxOutboxGone        = "gone"         // no longer at its place in Dropbox (moved, renamed or removed there): left alone, never "removed by Coral"
	DropboxOutboxEdited      = "edited"       // Dropbox refused the delete (the rev changed: edited there): kept, never retried; stage 5's
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
	// Stage 4b (#14703).
	RetainedOut int `json:"retained_out"`
	Gone        int `json:"gone"`
	Edited      int `json:"edited"`
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
	return o.MarkDoneBy(ctx, id, "", 0, fileID, rev, contentHash)
}

// MarkDoneBy records what Dropbox stored, in which account, and its size (stage 4b: retention reads only the current account's rows).
func (o *DropboxOutbox) MarkDoneBy(ctx context.Context, id int64, accountID string, size int64, fileID, rev, contentHash string) error {
	var acct any
	if accountID != "" {
		acct = accountID
	}
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET state = ?, file_id = ?, rev = ?, content_hash = ?, done_at = ?, account_id = ?, size = ? WHERE id = ?",
		DropboxOutboxDoneS, fileID, rev, contentHash, nowUTC(), acct, size, id)
	return err
}

// StampAccount gives the done rows stored before stage 4b (no account) the account connected now, and reports how many. Only one account has been
// connected before this stage on any database, so they are its files (the stage 4b delta v2, point 2).
func (o *DropboxOutbox) StampAccount(ctx context.Context, accountID string) (int, error) {
	if accountID == "" {
		return 0, errors.New("no account to stamp")
	}
	res, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET account_id = ? WHERE state = ? AND (account_id IS NULL OR account_id = '')", accountID, DropboxOutboxDoneS)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// LedgerRow is one file retention may delete: a done row of the current account, with what Dropbox said when Coral stored it.
type LedgerRow struct {
	ID         int64  `db:"id"`
	Kind       string `db:"kind"`
	Digest     string `db:"digest"`
	DocID      string `db:"doc_id"`
	Version    int    `db:"version"`
	Path       string `db:"path"`
	ArtifactAt string `db:"artifact_at"`
	Rev        string `db:"rev"`
	Size       int64  `db:"size"`
	DeleteJob  string `db:"delete_job"`
}

// LedgerSize counts the current account's done rows (retention's ceiling is half of them).
func (o *DropboxOutbox) LedgerSize(ctx context.Context, accountID string) (int, error) {
	var n int
	err := o.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM dropbox_outbox WHERE state = ? AND account_id = ?", DropboxOutboxDoneS, accountID)
	return n, err
}

// DueForRetention returns the current account's done rows whose artifact is older than before, oldest first, at most limit. Only paths under /v1/
// with a stored rev: anything else is never deleted.
func (o *DropboxOutbox) DueForRetention(ctx context.Context, accountID string, before time.Time, limit int) ([]LedgerRow, error) {
	var rows []LedgerRow
	err := o.db.SelectContext(ctx, &rows, `SELECT id, kind, digest, doc_id, version, path, artifact_at, COALESCE(rev, '') AS rev, size, COALESCE(delete_job, '') AS delete_job
		FROM dropbox_outbox WHERE state = ? AND account_id = ? AND artifact_at <> '' AND artifact_at < ? AND path LIKE '/v1/%' AND COALESCE(rev, '') <> ''
		ORDER BY artifact_at, doc_id, version, kind, id LIMIT ?`, DropboxOutboxDoneS, accountID, ts(before), limit)
	return rows, err
}

// Deleting returns the rows of the current account in a running retention job, by job.
func (o *DropboxOutbox) Deleting(ctx context.Context, accountID string) (map[string][]LedgerRow, error) {
	var rows []LedgerRow
	if err := o.db.SelectContext(ctx, &rows, `SELECT id, kind, digest, doc_id, version, path, artifact_at, COALESCE(rev, '') AS rev, size, COALESCE(delete_job, '') AS delete_job
		FROM dropbox_outbox WHERE state = ? AND account_id = ? ORDER BY id`, DropboxOutboxDeleting, accountID); err != nil {
		return nil, err
	}
	out := map[string][]LedgerRow{}
	for _, r := range rows {
		out[r.DeleteJob] = append(out[r.DeleteJob], r)
	}
	return out, nil
}

// MarkDeleting puts done rows in a running delete job. Only rows still done move, so a row is never in two jobs.
func (o *DropboxOutbox) MarkDeleting(ctx context.Context, ids []int64, job string) error {
	if job == "" {
		return errors.New("a delete job needs an id")
	}
	for _, id := range ids {
		if _, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET state = ?, delete_job = ? WHERE id = ? AND state = ?", DropboxOutboxDeleting, job, id, DropboxOutboxDoneS); err != nil {
			return err
		}
	}
	return nil
}

// MarkRetention records how a retention delete ended for a row: retained_out, gone or edited; or done again (to be tried later).
func (o *DropboxOutbox) MarkRetention(ctx context.Context, id int64, state string) error {
	switch state {
	case DropboxOutboxRetainedOut, DropboxOutboxGone, DropboxOutboxEdited, DropboxOutboxDoneS:
	default:
		return errors.New("not a retention outcome")
	}
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET state = ?, delete_job = NULL WHERE id = ? AND state IN (?, ?)", state, id, DropboxOutboxDoneS, DropboxOutboxDeleting)
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
		case DropboxOutboxRetainedOut:
			c.RetainedOut = r.N
		case DropboxOutboxGone:
			c.Gone = r.N
		case DropboxOutboxEdited:
			c.Edited = r.N
		case DropboxOutboxDeleting:
			c.BackedUp += r.N // still in Dropbox until the job says otherwise
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

// PathRow is a ledger row found by its path, for stage 5a's listing (#14714): by the outbox's unique path index (Security's SHOULD H).
type PathRow struct {
	ID          int64  `db:"id"`
	Kind        string `db:"kind"`
	Digest      string `db:"digest"`
	DocID       string `db:"doc_id"`
	Version     int    `db:"version"`
	Path        string `db:"path"`
	State       string `db:"state"`
	AccountID   string `db:"account_id"`
	Rev         string `db:"rev"`
	ContentHash string `db:"content_hash"`
}

// ByPath returns the row at path (sql.ErrNoRows when there is none).
func (o *DropboxOutbox) ByPath(ctx context.Context, path string) (PathRow, error) {
	var r PathRow
	err := o.db.GetContext(ctx, &r, `SELECT id, kind, digest, doc_id, version, path, state, COALESCE(account_id, '') AS account_id, COALESCE(rev, '') AS rev,
		COALESCE(content_hash, '') AS content_hash FROM dropbox_outbox WHERE path = ?`, path)
	return r, err
}

// SeeRev records a new rev of a file whose bytes did not change (a touch: the same content hash), so it is not seen as an edit again.
func (o *DropboxOutbox) SeeRev(ctx context.Context, id int64, rev string) error {
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET rev = ? WHERE id = ? AND state IN (?, ?)", rev, id, DropboxOutboxDoneS, DropboxOutboxEdited)
	return err
}

// Requeue queues a done row again: its file is gone from Dropbox while the local copy is here (v33 §8). Only a done row moves: never one that is
// deleting (retention's job), retained_out, gone or edited. The row then goes through the private re-read, the filters and retention's window like
// any upload (Security's SHOULD I).
func (o *DropboxOutbox) Requeue(ctx context.Context, id int64) (bool, error) {
	res, err := o.db.ExecContext(ctx, "UPDATE dropbox_outbox SET state = ?, next_try_at = '', attempts = 0, file_id = NULL, rev = NULL, content_hash = NULL WHERE id = ? AND state = ?",
		DropboxOutboxQueued, id, DropboxOutboxDoneS)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
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
