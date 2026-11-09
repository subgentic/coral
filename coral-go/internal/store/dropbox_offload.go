package store

// Dropbox stage 6b, Free up space (#14845; design v33 §7 and the 6b delta v2 with Security Reviewer's ten conditions): the Operator's setting,
// the record of artifacts whose local bytes were freed because Dropbox holds them, the record of opens, and the candidates for a pass. Nothing
// here removes a byte or calls Dropbox: the pass (routes) checks every candidate again, byte for byte, before anything goes.

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Stage 6b's bounds and limits.
const (
	DropboxOffloadMinDays   = 30 // the setting is 30 to 3650 days (0 is off)
	DropboxOffloadMaxDays   = 3650
	DropboxOffloadOpenedFor = 30 * 24 * time.Hour // nothing opened in the last 30 days is freed

	DropboxAuditOffloadSetting = "offload_setting" // the Operator's Free up space setting (old and new days, the dry-run count shown)
	DropboxAuditOffloadPass    = "offload_pass"    // an offload pass (count and bytes freed, or the refusal word)
)

// Offload is stage 6b's setting: free artifacts older than days (0 is off), and when the last pass ran ("" never).
func (s *DropboxStore) Offload(ctx context.Context) (days int, lastPass string, err error) {
	if err := s.ensureRow(ctx); err != nil {
		return 0, "", err
	}
	var r struct {
		Days int            `db:"offload_days"`
		Last sql.NullString `db:"offload_last_pass"`
	}
	if err := s.db.GetContext(ctx, &r, "SELECT offload_days, offload_last_pass FROM dropbox_connection WHERE id = 1"); err != nil {
		return 0, "", err
	}
	return r.Days, r.Last.String, nil
}

// SetOffload records the setting; the caller has checked that it is the Operator's and that the confirms were given.
func (s *DropboxStore) SetOffload(ctx context.Context, days int) error {
	if days != 0 && (days < DropboxOffloadMinDays || days > DropboxOffloadMaxDays) {
		return errors.New("free up space is 0 (off) or 30 to 3650 days")
	}
	if err := s.ensureRow(ctx); err != nil {
		return err
	}
	var since any
	if days > 0 {
		since = nowUTC()
	}
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET offload_days = ?, offload_since = ? WHERE id = 1", days, since)
	return err
}

// SetOffloadPass records when an offload pass ran (RFC 3339, UTC).
func (s *DropboxStore) SetOffloadPass(ctx context.Context, at string) error {
	_, err := s.db.ExecContext(ctx, "UPDATE dropbox_connection SET offload_last_pass = ? WHERE id = 1", at)
	return err
}

// DropboxOffloaded is one artifact whose local bytes were freed: the ledger row checked right before they went.
type DropboxOffloaded struct {
	Digest      string `db:"digest"`
	AccountID   string `db:"account_id"`
	Path        string `db:"path"`
	Rev         string `db:"rev"`
	ContentHash string `db:"content_hash"`
	Size        int64  `db:"size"`
	At          string `db:"at"`
}

// RecordOffloaded writes the row before the local bytes go (the pass commits it first: a crash after it leaves the bytes, never a missing row).
// A row already there for the digest is an error: one object is freed once.
func (o *DropboxOutbox) RecordOffloaded(ctx context.Context, r DropboxOffloaded) error {
	if r.Digest == "" || r.AccountID == "" || r.Path == "" || r.Rev == "" || r.ContentHash == "" {
		return errors.New("an offload row needs its digest, account, path, rev and content hash")
	}
	if r.At == "" {
		r.At = nowUTC()
	}
	_, err := o.db.ExecContext(ctx, `INSERT INTO dropbox_offloaded (digest, account_id, path, rev, content_hash, size, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.Digest, r.AccountID, r.Path, r.Rev, r.ContentHash, r.Size, r.At)
	return err
}

// Offloaded returns the row of a digest, and whether there is one. An error is not "none": callers that decide on it fail closed.
func (o *DropboxOutbox) Offloaded(ctx context.Context, digest string) (DropboxOffloaded, bool, error) {
	var r DropboxOffloaded
	err := o.db.GetContext(ctx, &r, "SELECT digest, account_id, path, rev, content_hash, size, at FROM dropbox_offloaded WHERE digest = ?", digest)
	if errors.Is(err, sql.ErrNoRows) {
		return DropboxOffloaded{}, false, nil
	}
	if err != nil {
		return DropboxOffloaded{}, false, err
	}
	return r, true, nil
}

// ForgetOffloaded removes the row once the bytes are back (or the artifact is deleted here and its marker removed).
func (o *DropboxOutbox) ForgetOffloaded(ctx context.Context, digest string) error {
	_, err := o.db.ExecContext(ctx, "DELETE FROM dropbox_offloaded WHERE digest = ?", digest)
	return err
}

// OffloadedAll returns every freed artifact, oldest first (turning Free up space off fetches them back in this order).
func (o *DropboxOutbox) OffloadedAll(ctx context.Context, limit int) ([]DropboxOffloaded, error) {
	var out []DropboxOffloaded
	err := o.db.SelectContext(ctx, &out, "SELECT digest, account_id, path, rev, content_hash, size, at FROM dropbox_offloaded ORDER BY at, digest LIMIT ?", limit)
	return out, err
}

// OffloadedTotals counts the freed artifacts and their bytes (the status: N files are kept only in Dropbox).
func (o *DropboxOutbox) OffloadedTotals(ctx context.Context) (n int, bytes int64, err error) {
	var r struct {
		N     int   `db:"n"`
		Bytes int64 `db:"b"`
	}
	err = o.db.GetContext(ctx, &r, "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM dropbox_offloaded")
	return r.N, r.Bytes, err
}

// RecordOpened notes that an artifact was opened now (a fetch-back, or the Operator's recorded open), so it is not freed for 30 days.
func (o *DropboxOutbox) RecordOpened(ctx context.Context, digest string, at time.Time) error {
	_, err := o.db.ExecContext(ctx, `INSERT INTO dropbox_opened (digest, at) VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET at = MAX(at, excluded.at)`, digest, ts(at))
	return err
}

// OffloadCandidate is one object a pass may free, from the ledger row whose copy the pass checks.
type OffloadCandidate struct {
	ID          int64  `db:"id"`
	Digest      string `db:"digest"`
	DocID       string `db:"doc_id"`
	Version     int    `db:"version"`
	Path        string `db:"path"`
	ArtifactAt  string `db:"artifact_at"`
	Rev         string `db:"rev"`
	ContentHash string `db:"content_hash"`
	Size        int64  `db:"size"`
}

// OffloadCandidates returns the objects a pass may free, oldest first, at most limit: the version file of the account connected now, under /v1/
// (the exact prefix), done with a rev and a content hash, older than before by Coral's own artifact time, where EVERY ledger row of the same bytes
// (its sidecar and any other document's) is done too (so nothing edited, removed, retained out, deleting, gone, queued, failed, private or parked),
// with a done sidecar beside it, no open edit (5a), not already freed, not kept or starred by anyone, and not opened since openedBefore.
// One row an object: the oldest version file that holds it. The pass checks each one again before a byte goes.
func (o *DropboxOutbox) OffloadCandidates(ctx context.Context, accountID string, before, openedBefore time.Time, limit int) ([]OffloadCandidate, error) {
	if accountID == "" {
		return nil, errors.New("no account")
	}
	var rows []OffloadCandidate
	err := o.db.SelectContext(ctx, &rows, `SELECT v.id, v.digest, v.doc_id, v.version, v.path, v.artifact_at, v.rev, v.content_hash, v.size
		FROM dropbox_outbox v
		WHERE v.kind = ? AND v.state = ? AND v.account_id = ? AND substr(v.path, 1, 4) = '/v1/'
		  AND COALESCE(v.rev, '') <> '' AND COALESCE(v.content_hash, '') <> '' AND v.artifact_at <> '' AND v.artifact_at < ?
		  AND v.id = (SELECT MIN(x.id) FROM dropbox_outbox x WHERE x.digest = v.digest AND x.kind = ?)
		  AND NOT EXISTS (SELECT 1 FROM dropbox_outbox o WHERE o.digest = v.digest AND (o.state <> ? OR COALESCE(o.account_id, '') <> v.account_id))
		  AND EXISTS (SELECT 1 FROM dropbox_outbox s WHERE s.kind = ? AND s.digest = v.digest AND s.doc_id = v.doc_id AND s.version = v.version AND s.state = ?)
		  AND NOT EXISTS (SELECT 1 FROM dropbox_edits e WHERE (e.doc_id = v.doc_id OR e.orig_digest = v.digest) AND e.state IN (?, ?))
		  AND NOT EXISTS (SELECT 1 FROM dropbox_offloaded d WHERE d.digest = v.digest)
		  AND NOT EXISTS (SELECT 1 FROM artifact_keep k WHERE k.hex = v.digest)
		  AND NOT EXISTS (SELECT 1 FROM artifact_stars st WHERE st.hex = v.digest)
		  AND NOT EXISTS (SELECT 1 FROM artifact_person_stars ps WHERE ps.hex = v.digest)
		  AND NOT EXISTS (SELECT 1 FROM dropbox_opened op WHERE op.digest = v.digest AND op.at >= ?)
		ORDER BY v.artifact_at, v.id LIMIT ?`,
		DropboxKindVersion, DropboxOutboxDoneS, accountID, ts(before), DropboxKindVersion, DropboxOutboxDoneS,
		DropboxKindItemData, DropboxOutboxDoneS, DropboxEditPending, DropboxEditDeciding, ts(openedBefore), limit)
	return rows, err
}
