package store

// Removals from Dropbox after the Operator deleted an artifact here (#14814, reworked to the Operator's answers: deleting a file in Coral deletes
// its Dropbox copy too). Security's conditions on it: only the Operator's own delete queues one; it waits out a grace (24 hours) and survives a
// restart; many deletes at once are held for the Operator's confirm; an upload of the same bytes cancels it; 6a's safety rules decide the rest
// (routes). Nothing here calls Dropbox.

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Removal states, reasons and the mass-delete guard.
const (
	DropboxRemovalWaiting = "waiting" // runs once due
	DropboxRemovalHeld    = "held"    // many deletes at once: waits for the Operator's confirm
	DropboxRemovalKept    = "kept"    // another Coral keeps it only in Dropbox, or its markers could not be read: left alone, listed
	DropboxRemovalEdited  = "edited"  // edited in Dropbox: listed with Remove anyway

	DropboxRemovalHeldMany = "many" // more than DropboxRemovalGuard deletes in an hour
	DropboxRemovalHeldBulk = "bulk" // one delete of many files (a series)

	DropboxRemovalGrace = 24 * time.Hour
	DropboxRemovalGuard = 50 // more queued than this in an hour holds them all
)

// DropboxRemoval is one waiting, held, kept or edited removal.
type DropboxRemoval struct {
	Digest    string `db:"digest" json:"digest"`
	Name      string `db:"name" json:"name"`
	State     string `db:"state" json:"state"`
	QueuedAt  string `db:"queued_at" json:"queued_at"`
	DueAt     string `db:"due_at" json:"due_at"`
	NextTryAt string `db:"next_try_at" json:"-"`
	Attempts  int    `db:"attempts" json:"-"`
	Reason    string `db:"reason" json:"reason,omitempty"`
	Others    string `db:"others" json:"-"`
	Unknown   int    `db:"unknown" json:"unknown,omitempty"`
	Edited    string `db:"edited" json:"-"`
}

// OthersList is the last 4 characters of each other Coral that keeps the file only in Dropbox.
func (r DropboxRemoval) OthersList() []string {
	if r.Others == "" {
		return nil
	}
	return strings.Split(r.Others, ",")
}

// cleanName keeps a file name for Settings: no control or format characters, at most 128 bytes.
func cleanName(n string) string {
	n = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x200b && r <= 0x200f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0xfeff {
			return -1
		}
		return r
	}, n)
	for len(n) > 128 {
		r := []rune(n)
		n = string(r[:len(r)-1])
	}
	return n
}

// QueueRemoval queues the removal of digest from Dropbox, due after the grace. bulk is one delete of many files: held. More than
// DropboxRemovalGuard removals queued within an hour hold them all (those already waiting in that hour too), so one wrong click or a script
// never empties the backup on its own. A digest queued again starts again. It reports the state given.
func (o *DropboxOutbox) QueueRemoval(ctx context.Context, digest, name string, now time.Time, bulk bool) (string, error) {
	if digest == "" {
		return "", errors.New("no digest")
	}
	var recent int
	if err := o.db.GetContext(ctx, &recent, "SELECT COUNT(*) FROM dropbox_removals WHERE queued_at >= ? AND state IN (?, ?) AND digest <> ?",
		ts(now.Add(-time.Hour)), DropboxRemovalWaiting, DropboxRemovalHeld, digest); err != nil {
		return "", err
	}
	state, reason := DropboxRemovalWaiting, ""
	switch {
	case bulk:
		state, reason = DropboxRemovalHeld, DropboxRemovalHeldBulk
	case recent+1 > DropboxRemovalGuard:
		state, reason = DropboxRemovalHeld, DropboxRemovalHeldMany
	}
	if _, err := o.db.ExecContext(ctx, `INSERT OR REPLACE INTO dropbox_removals (digest, name, state, queued_at, due_at, reason) VALUES (?, ?, ?, ?, ?, ?)`,
		digest, cleanName(name), state, ts(now), ts(now.Add(DropboxRemovalGrace)), reason); err != nil {
		return "", err
	}
	if reason == DropboxRemovalHeldMany {
		if _, err := o.db.ExecContext(ctx, "UPDATE dropbox_removals SET state = ?, reason = ? WHERE state = ? AND queued_at >= ?",
			DropboxRemovalHeld, DropboxRemovalHeldMany, DropboxRemovalWaiting, ts(now.Add(-time.Hour))); err != nil {
			return "", err
		}
	}
	return state, nil
}

// CancelRemoval forgets the removal of a digest (an upload of the same bytes, or the Operator's Cancel / Keep in Dropbox), and reports whether
// there was one.
func (o *DropboxOutbox) CancelRemoval(ctx context.Context, digest string) (bool, error) {
	res, err := o.db.ExecContext(ctx, "DELETE FROM dropbox_removals WHERE digest = ?", digest)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// CancelRemovals forgets every removal in one state (Cancel all, Keep them in Dropbox), and reports how many.
func (o *DropboxOutbox) CancelRemovals(ctx context.Context, state string) (int, error) {
	res, err := o.db.ExecContext(ctx, "DELETE FROM dropbox_removals WHERE state = ?", state)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// ConfirmHeld lets the held removals go (the Operator's "Remove them"): they wait out the rest of their grace like any other.
func (o *DropboxOutbox) ConfirmHeld(ctx context.Context) (int, error) {
	res, err := o.db.ExecContext(ctx, "UPDATE dropbox_removals SET state = ?, reason = '' WHERE state = ?", DropboxRemovalWaiting, DropboxRemovalHeld)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// DueRemovals returns the waiting removals whose grace and retry time have passed, oldest first, at most limit.
func (o *DropboxOutbox) DueRemovals(ctx context.Context, now time.Time, limit int) ([]DropboxRemoval, error) {
	var out []DropboxRemoval
	err := o.db.SelectContext(ctx, &out, `SELECT digest, name, state, queued_at, due_at, next_try_at, attempts, reason, others, unknown, edited FROM dropbox_removals
		WHERE state = ? AND due_at <= ? AND next_try_at <= ? ORDER BY due_at, digest LIMIT ?`, DropboxRemovalWaiting, ts(now), ts(now), limit)
	return out, err
}

// Removal returns one removal, and whether there is one.
func (o *DropboxOutbox) Removal(ctx context.Context, digest string) (DropboxRemoval, bool, error) {
	var r DropboxRemoval
	err := o.db.GetContext(ctx, &r, `SELECT digest, name, state, queued_at, due_at, next_try_at, attempts, reason, others, unknown, edited FROM dropbox_removals WHERE digest = ?`, digest)
	if errors.Is(err, sql.ErrNoRows) {
		return DropboxRemoval{}, false, nil
	}
	return r, err == nil, err
}

// Removals lists every removal for Settings, by state then time, at most limit.
func (o *DropboxOutbox) Removals(ctx context.Context, limit int) ([]DropboxRemoval, error) {
	var out []DropboxRemoval
	err := o.db.SelectContext(ctx, &out, `SELECT digest, name, state, queued_at, due_at, next_try_at, attempts, reason, others, unknown, edited FROM dropbox_removals
		ORDER BY CASE state WHEN 'held' THEN 0 WHEN 'kept' THEN 1 WHEN 'edited' THEN 2 ELSE 3 END, due_at, digest LIMIT ?`, limit)
	return out, err
}

// RemovalCounts counts the removals by state.
func (o *DropboxOutbox) RemovalCounts(ctx context.Context) (map[string]int, error) {
	var rows []struct {
		State string `db:"state"`
		N     int    `db:"n"`
	}
	if err := o.db.SelectContext(ctx, &rows, "SELECT state, COUNT(*) AS n FROM dropbox_removals GROUP BY state"); err != nil {
		return nil, err
	}
	out := map[string]int{}
	for _, r := range rows {
		out[r.State] = r.N
	}
	return out, nil
}

// RetryRemoval puts a removal off until at (Dropbox could not be reached, or a job is still running): it stays waiting.
func (o *DropboxOutbox) RetryRemoval(ctx context.Context, digest string, at time.Time) error {
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_removals SET attempts = attempts + 1, next_try_at = ? WHERE digest = ? AND state = ?", ts(at), digest, DropboxRemovalWaiting)
	return err
}

// KeepRemoval parks a removal Coral must not make on its own: another Coral keeps the file only in Dropbox (others, unknown), or the markers could
// not be read. It is listed in Settings with the typed confirm.
func (o *DropboxOutbox) KeepRemoval(ctx context.Context, digest, reason string, others []string, unknown int) error {
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_removals SET state = ?, reason = ?, others = ?, unknown = ? WHERE digest = ?",
		DropboxRemovalKept, reason, strings.Join(others, ","), unknown, digest)
	return err
}

// EditedRemoval parks a removal whose file was edited in Dropbox: editedJSON holds the ledger paths and the revs Dropbox has now, for Remove anyway.
func (o *DropboxOutbox) EditedRemoval(ctx context.Context, digest, editedJSON string) error {
	_, err := o.db.ExecContext(ctx, "UPDATE dropbox_removals SET state = ?, reason = '', edited = ? WHERE digest = ?", DropboxRemovalEdited, editedJSON, digest)
	return err
}
