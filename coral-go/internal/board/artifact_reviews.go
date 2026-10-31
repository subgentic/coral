package board

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

// The Operator's review of a team's artifact (#136584): an artifact tagged "for review" is approved, or has changes requested, and the state has a time. The tags carry the state the lists filter on (the
// row leaves Needs you when "for review" is replaced by "approved"; "changes requested" is added and the row stays); this table holds when, so the viewer can say "Approved 10:42". A review belongs to a team's
// use of a stored object, as the tags do.

const (
	ReviewApproved         = "approved"
	ReviewChangesRequested = "changes requested"
	ReviewDenied           = "denied"  // the Operator's final no (#11552): the row leaves Needs you and a later approve or changes is refused; a new version of the file is a new row
	tagIgnored             = "ignored" // the Operator took it out of Needs you with no verdict and no message; Unignore puts "for review" back
	tagForReview           = "for review"
	tagRead                = "read"
	tagReviewed            = "reviewed"
)

// ErrNotForReview is a decision on an artifact that is not waiting for one.
var ErrNotForReview = errors.New("this artifact is not waiting for a review")

// ArtifactReview is the recorded state of one review.
type ArtifactReview struct {
	State string `json:"state"`
	At    string `json:"at"`
}

func (s *Store) ensureArtifactReviewsSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS artifact_reviews (
		board_id TEXT NOT NULL,
		hex      TEXT NOT NULL,
		state    TEXT NOT NULL,
		at       TEXT NOT NULL,
		PRIMARY KEY (board_id, hex)
	)`)
	return err
}

// ArtifactReviews maps each reviewed stored object of the board to its state and time.
func (s *Store) ArtifactReviews(ctx context.Context, boardID string) (map[string]ArtifactReview, error) {
	var rows []struct {
		Hex   string `db:"hex"`
		State string `db:"state"`
		At    string `db:"at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT hex, state, at FROM artifact_reviews WHERE board_id = ?`, boardID); err != nil {
		return nil, err
	}
	out := make(map[string]ArtifactReview, len(rows))
	for _, r := range rows {
		out[r.Hex] = ArtifactReview{State: r.State, At: r.At}
	}
	return out, nil
}

// ReviewChange is what a decision changed, to be put back when what follows it (a message to the agent) fails.
type ReviewChange struct {
	Changed   bool // false: the object was already in this state, nothing was written
	prevTags  []string
	prevState *ArtifactReview
	board     string
	hex       string
}

// DecideArtifactReview records the Operator's decision for the object on the board, in one transaction. approve takes "for review", "read" and "changes requested" off and puts "approved" on, which is what takes the
// row out of Needs you; changes keeps "for review" and puts "changes requested" on. A second approve (or a second request of the same changes) changes nothing. An object with no "for review" tag and no
// review row is not waiting for a decision: ErrNotForReview (an object already "reviewed" by the old Mark reviewed counts as settled, and is refused the same way).
func (s *Store) DecideArtifactReview(ctx context.Context, boardID, hex, state string, now time.Time) (ReviewChange, []string, error) {
	ch := ReviewChange{board: boardID, hex: hex}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return ch, nil, err
	}
	defer tx.Rollback()
	var have []string
	if err := tx.SelectContext(ctx, &have, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return ch, nil, err
	}
	ch.prevTags = have
	set := map[string]bool{}
	for _, t := range have {
		set[t] = true
	}
	var cur ArtifactReview
	err = tx.GetContext(ctx, &cur, `SELECT state, at FROM artifact_reviews WHERE board_id = ? AND hex = ?`, boardID, hex)
	switch {
	case err == nil:
		c := cur
		ch.prevState = &c
	case errors.Is(err, sql.ErrNoRows):
	default:
		return ch, nil, err
	}
	if ch.prevState != nil && ch.prevState.State == state && (state == ReviewApproved || state == ReviewDenied || set[tagForReview]) {
		return ch, have, nil // already decided this way
	}
	if state == ReviewChangesRequested && ch.prevState != nil && ch.prevState.State == ReviewApproved {
		return ch, have, ErrNotForReview // approved is settled: a later request needs a new version
	}
	if !set[tagForReview] && !(ch.prevState != nil && ch.prevState.State == ReviewChangesRequested) {
		return ch, have, ErrNotForReview
	}
	next := map[string]bool{}
	for t := range set {
		next[t] = true
	}
	switch state {
	case ReviewApproved:
		delete(next, tagForReview)
		delete(next, tagRead)
		delete(next, ReviewChangesRequested)
		delete(next, tagReviewed)
		next[ReviewApproved] = true
	case ReviewChangesRequested:
		next[tagForReview] = true
		next[ReviewChangesRequested] = true
		delete(next, tagRead) // it is something to read again: the agent changes it
	case ReviewDenied:
		delete(next, tagForReview)
		delete(next, tagRead)
		delete(next, ReviewChangesRequested)
		delete(next, tagReviewed)
		next[ReviewDenied] = true
	}
	if len(next) > MaxArtifactTags {
		return ch, have, ErrArtifactTag
	}
	tags := make([]string, 0, len(next))
	for t := range next {
		tags = append(tags, t)
	}
	sort.Strings(tags)
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil {
		return ch, nil, err
	}
	for _, t := range tags {
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, t); err != nil {
			return ch, nil, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_reviews (board_id, hex, state, at) VALUES (?, ?, ?, ?)
		ON CONFLICT(board_id, hex) DO UPDATE SET state = excluded.state, at = excluded.at`, boardID, hex, state, now.UTC().Format(time.RFC3339)); err != nil {
		return ch, nil, err
	}
	if err := tx.Commit(); err != nil {
		return ch, nil, err
	}
	ch.Changed = true
	return ch, tags, nil
}

// UndoArtifactReview puts back what DecideArtifactReview changed (the tags and the review row as they were), for a decision whose message to the agent could not be posted: the button can be pressed again.
func (s *Store) UndoArtifactReview(ctx context.Context, ch ReviewChange) error {
	if !ch.Changed {
		return nil
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ?`, ch.board, ch.hex); err != nil {
		return err
	}
	for _, t := range ch.prevTags {
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, ch.board, ch.hex, t); err != nil {
			return err
		}
	}
	if ch.prevState == nil {
		_, err = tx.ExecContext(ctx, `DELETE FROM artifact_reviews WHERE board_id = ? AND hex = ?`, ch.board, ch.hex)
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO artifact_reviews (board_id, hex, state, at) VALUES (?, ?, ?, ?)
			ON CONFLICT(board_id, hex) DO UPDATE SET state = excluded.state, at = excluded.at`, ch.board, ch.hex, ch.prevState.State, ch.prevState.At)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

// ReviewSuperseded is the state of a review whose artifact has a newer version in its series that is for review itself.
const ReviewSuperseded = "superseded"

// SupersedeArtifactReview closes the review of an older version of an artifact (#136588): when the agent uploads the next version of the series for review, the older one, still waiting or with changes
// requested, is no longer something to review ("for review", "read" and "changes requested" go, "superseded" comes), and the new version is the pending one. Anything else (approved, never for review) is left alone.
func (s *Store) SupersedeArtifactReview(ctx context.Context, boardID, hex string, now time.Time) (bool, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var have []string
	if err := tx.SelectContext(ctx, &have, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return false, err
	}
	waiting := false
	for _, t := range have {
		waiting = waiting || t == tagForReview
	}
	if !waiting {
		return false, nil
	}
	for _, t := range []string{tagForReview, tagRead, ReviewChangesRequested} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ? AND tag = ?`, boardID, hex, t); err != nil {
			return false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, ReviewSuperseded); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_reviews (board_id, hex, state, at) VALUES (?, ?, ?, ?)
		ON CONFLICT(board_id, hex) DO UPDATE SET state = excluded.state, at = excluded.at`, boardID, hex, ReviewSuperseded, now.UTC().Format(time.RFC3339)); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// IgnoreArtifactReview takes an artifact out of Needs you with no verdict (#11552): "for review" is replaced by "ignored" and every other tag stays (read, changes requested), so Unignore (on false) puts
// it back exactly as it was. No review row is written and the caller posts nothing. Ignoring twice changes nothing; an artifact that is not waiting for a review (or, to unignore, is not ignored) is
// ErrNotForReview.
func (s *Store) IgnoreArtifactReview(ctx context.Context, boardID, hex string, ignore bool) (ReviewChange, []string, error) {
	ch := ReviewChange{board: boardID, hex: hex}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return ch, nil, err
	}
	defer tx.Rollback()
	var have []string
	if err := tx.SelectContext(ctx, &have, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return ch, nil, err
	}
	ch.prevTags = have
	set := map[string]bool{}
	for _, t := range have {
		set[t] = true
	}
	from, to := tagForReview, tagIgnored
	if !ignore {
		from, to = tagIgnored, tagForReview
	}
	if ignore && set[tagIgnored] && !set[tagForReview] {
		return ch, have, nil // ignored already
	}
	if !set[from] {
		return ch, have, ErrNotForReview
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ? AND tag = ?`, boardID, hex, from); err != nil {
		return ch, nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, to); err != nil {
		return ch, nil, err
	}
	var tags []string
	if err := tx.SelectContext(ctx, &tags, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return ch, nil, err
	}
	if err := tx.Commit(); err != nil {
		return ch, nil, err
	}
	ch.Changed = true
	return ch, tags, nil
}
