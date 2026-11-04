package board

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"github.com/jmoiron/sqlx"
	"time"
)

// The Operator's review of a team's artifact (#136584): an artifact tagged "for review" is approved, or has changes requested, and the state has a time. The tags carry the state the lists filter on (the
// row leaves Needs you when "for review" is replaced by "approved"; "changes requested" is added, "for review" stays and the row leaves Needs you: it is the agent's turn, and its next version is a new item, #11985); this table holds when, so the viewer can say "Approved 10:42". A review belongs to a team's
// use of a stored object, as the tags do.

const (
	ReviewApproved         = "approved"
	ReviewChangesRequested = "changes requested"
	ReviewDenied           = "denied"  // the Operator's final no (#11552): the row leaves Needs you and a later approve or changes is refused; a new version of the file is a new row
	tagIgnored             = "ignored" // the Operator took it out of Needs you with no verdict and no message; Unignore puts "for review" back
	tagForReview           = "for review"
	tagRead                = "read"
	tagSaved               = "saved" // the Operator put a file for review aside (#11641): it is still for review, but out of Needs you and its counts until moved back or decided
	tagReviewed            = "reviewed"
)

// ErrNotForReview is a decision on an artifact that is not waiting for one.
var ErrNotForReview = errors.New("this artifact is not waiting for a review")

// ErrAlreadyDecided is a decision on a file that already has a DIFFERENT approve, changes or deny decision, for a caller that asked to refuse a conflicting one (WithOneDecision): the same decision again is no error (#13494).
var ErrAlreadyDecided = errors.New("this artifact already has a different decision")

type oneDecisionKey struct{}

// WithOneDecision says a review decision on this context must not replace a different one already made on the file (#13494, coral-hub: agents act on decisions, so two conflicting decisions on one file is the risk). It is
// judged inside the decision's own transaction, with the stored state, so two requests at once cannot both pass.
func WithOneDecision(ctx context.Context) context.Context {
	return context.WithValue(ctx, oneDecisionKey{}, true)
}

func oneDecision(ctx context.Context) bool { v, _ := ctx.Value(oneDecisionKey{}).(bool); return v }

// ArtifactReview is the recorded state of one review.
type ArtifactReview struct {
	State string `json:"state"`
	At    string `json:"at"`
}

// ensureArtifactReviewSentSchema makes the table of when each file was sent for review (#13231): the time "for review" was last put on it (an upload with the tag, a task result, the tag editor, the Operator's send
// route), kept apart from the file's own time so "waiting longer than X" counts from when the review began and a re-send starts it again.
func (s *Store) ensureArtifactReviewSentSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS artifact_review_sent (
		board_id TEXT NOT NULL,
		hex      TEXT NOT NULL,
		at       TEXT NOT NULL,
		PRIMARY KEY (board_id, hex)
	)`)
	return err
}

// noteReviewTag keeps the sent-for-review time in step with a write of the object's tags: the time is set when "for review" is put on a file that did not have it, and left alone while the file keeps it.
func noteReviewTag(ctx context.Context, tx *sqlx.Tx, boardID, hex string, had, has bool, at time.Time) error {
	if had || !has {
		return nil
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO artifact_review_sent (board_id, hex, at) VALUES (?, ?, ?) ON CONFLICT(board_id, hex) DO UPDATE SET at = excluded.at`, boardID, hex, at.UTC().Format(time.RFC3339))
	return err
}

// ArtifactReviewSent maps each file of the board that was sent for review to when (RFC 3339, UTC). A file that carries the tag from before the time was kept has none: the page falls back to the file's own time.
func (s *Store) ArtifactReviewSent(ctx context.Context, boardID string) (map[string]string, error) {
	var rows []struct {
		Hex string `db:"hex"`
		At  string `db:"at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT hex, at FROM artifact_review_sent WHERE board_id = ?`, boardID); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Hex] = r.At
	}
	return out, nil
}

// reviewRoundTags are what an earlier round of review left on a file: the Operator's decision and their marks, which a new round starts without ("saved" is theirs to keep).
var reviewRoundTags = map[string]bool{ReviewApproved: true, ReviewChangesRequested: true, ReviewDenied: true, tagIgnored: true, ReviewSuperseded: true, tagRead: true, tagReviewed: true}

// StartArtifactReview sends the file to the Operator for review (#13217, #13231), in one transaction: "for review" goes on, the time it was sent is set, and a file that was decided before starts a new round: its
// decision (approved, changes requested, denied, ignored, superseded) and its "read" mark go, and the review row with them, so Needs you shows it as new. It reports the tags after and the earlier decision ("" for none).
// A file that is already waiting is left as it is (its time too). ErrArtifactTag when the tags would be more than a file may have.
func (s *Store) StartArtifactReview(ctx context.Context, boardID, hex string, at time.Time) (tags []string, was string, err error) {
	s.activityMu.Lock() // the Operator's record is written in this transaction (the send and its row stand or fall together): one writer of its chain at a time
	defer s.activityMu.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback()
	var have []string
	if err := tx.SelectContext(ctx, &have, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return nil, "", err
	}
	waiting := false
	for _, t := range have {
		if t == tagForReview {
			waiting = true
		}
	}
	var prior string
	_ = tx.GetContext(ctx, &prior, `SELECT state FROM artifact_reviews WHERE board_id = ? AND hex = ?`, boardID, hex)
	next := map[string]bool{}
	decided := ""
	for _, t := range have {
		if reviewRoundTags[t] && !waiting {
			if t == ReviewApproved || t == ReviewChangesRequested || t == ReviewDenied {
				decided = t
			}
			continue
		}
		next[t] = true
	}
	if decided == "" && !waiting {
		decided = prior
	}
	next[tagForReview] = true
	if len(next) > MaxArtifactTags {
		return nil, "", ErrArtifactTag
	}
	out := make([]string, 0, len(next))
	for t := range next {
		out = append(out, t)
	}
	sort.Strings(out)
	if !waiting {
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil {
			return nil, "", err
		}
		for _, t := range out {
			if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, t); err != nil {
				return nil, "", err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_reviews WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil {
			return nil, "", err
		}
		if err := noteReviewTag(ctx, tx, boardID, hex, false, true, at); err != nil {
			return nil, "", err
		}
	} else {
		out = have
	}
	if m, ok := activityOf(ctx); ok { // the row of the send, with the earlier decision in its note when this starts a new round
		if !waiting && decided != "" {
			m.Note = strings.TrimSpace("again after " + decided + ". " + m.Note)
		}
		if err := s.recordInTx(WithActivity(ctx, m), tx, at, ActSendReview, "file", hex, "", boardID); err != nil {
			return nil, "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, "", err
	}
	return out, decided, nil
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
	// prevQuestion is the upload's question a decision cleared (#11555), put back by UndoArtifactReview.
	prevQuestion *ArtifactQuestionRow
	board        string
	hex          string
}

// DecideArtifactReview records the Operator's decision for the object on the board, in one transaction. approve takes "for review", "read" and "changes requested" off and puts "approved" on, which is what takes the
// row out of Needs you; changes keeps "for review" and puts "changes requested" on (the file then waits on the agent: /api/needs-you and the page do not list it, #11985). A second approve (or a second request of the same changes) changes nothing. An object with no "for review" tag and no
// review row is not waiting for a decision: ErrNotForReview (an object already "reviewed" by the old Mark reviewed counts as settled, and is refused the same way).
func (s *Store) DecideArtifactReview(ctx context.Context, boardID, hex, state string, now time.Time) (ReviewChange, []string, error) {
	ch := ReviewChange{board: boardID, hex: hex}
	s.activityMu.Lock() // the chain's row is written in this transaction: one writer at a time
	defer s.activityMu.Unlock()
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
	var q ArtifactQuestionRow
	if qerr := tx.GetContext(ctx, &q, `SELECT question, session_id, asked_at FROM artifact_questions WHERE board_id = ? AND hex = ?`, boardID, hex); qerr == nil {
		ch.prevQuestion = &q
	} else if !errors.Is(qerr, sql.ErrNoRows) {
		return ch, nil, qerr
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
	if oneDecision(ctx) && ch.prevState != nil && ch.prevState.State != state && (ch.prevState.State == ReviewApproved || ch.prevState.State == ReviewChangesRequested || ch.prevState.State == ReviewDenied) {
		return ch, have, ErrAlreadyDecided // a Hub caller does not change a decision already made (#13494)
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
		delete(next, tagSaved)
		delete(next, tagReviewed)
		next[ReviewApproved] = true
	case ReviewChangesRequested:
		next[tagForReview] = true
		next[ReviewChangesRequested] = true
		delete(next, tagRead)  // it is something to read again: the agent changes it
		delete(next, tagSaved) // and it is not saved for later: it waits on the agent, not on the Operator (#11985)
	case ReviewDenied:
		delete(next, tagForReview)
		delete(next, tagRead)
		delete(next, ReviewChangesRequested)
		delete(next, tagSaved)
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
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_questions WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil { // the review is decided: what it asked is answered (#11555)
		return ch, nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_reviews (board_id, hex, state, at) VALUES (?, ?, ?, ?)
		ON CONFLICT(board_id, hex) DO UPDATE SET state = excluded.state, at = excluded.at`, boardID, hex, state, now.UTC().Format(time.RFC3339)); err != nil {
		return ch, nil, err
	}
	s.noteActivity(ctx, tx, now, map[string]string{ReviewApproved: ActApprove, ReviewChangesRequested: ActChanges, ReviewDenied: ActDeny}[state], "file", hex, hex, boardID) // the decision and its row are one transaction
	if err := tx.Commit(); err != nil {
		return ch, nil, err
	}
	s.NoteArtifactsChanged(boardID)
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
	if ch.prevQuestion != nil {
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_questions (board_id, hex, question, session_id, asked_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(board_id, hex) DO UPDATE SET question = excluded.question, session_id = excluded.session_id, asked_at = excluded.asked_at`,
			ch.board, ch.hex, ch.prevQuestion.Question, ch.prevQuestion.Session, ch.prevQuestion.At); err != nil {
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
	if err := tx.Commit(); err != nil {
		return err
	}
	s.NoteArtifactsChanged(ch.board)
	if m, ok := activityOf(ctx); ok { // the decision was rolled back (the agent could not be told): the record says so, as one more row
		_ = s.RecordActivity(ctx, m, ActUndone, "file", ch.hex, ch.hex, ch.board)
	}
	return nil
}

// ReviewSuperseded is the state of a review whose artifact has a newer version in its series that is for review itself.
const ReviewSuperseded = "superseded"

// ErrNotOlderReview means no verified newer candidate still has a review or an
// approved/denied decision. The route supplies candidates from upload records.
var ErrNotOlderReview = errors.New("this is not an older version with a newer review")

// SupersedeArtifactReview closes the review of an older version of an artifact (#136588): when the agent uploads the next version of the series for review, the older one, still waiting or with changes
// requested, is no longer something to review ("for review", "read", "saved" and "changes requested" go, "superseded" comes), and the new version is the pending one. Anything else (approved, never for review) is left alone.
func (s *Store) SupersedeArtifactReview(ctx context.Context, boardID, hex string, now time.Time) (bool, error) {
	return s.supersedeArtifactReview(ctx, boardID, hex, nil, now, false)
}

// SettleOlderArtifactReview checks the newer candidates' state and records the
// automatic settlement in Activity in the same transaction as the tag changes.
// The caller has verified that candidates are strictly newer versions of this
// series, which already excludes the artifact being settled.
func (s *Store) SettleOlderArtifactReview(ctx context.Context, boardID, hex string, newer []string, now time.Time) (bool, error) {
	s.activityMu.Lock()
	defer s.activityMu.Unlock()
	return s.supersedeArtifactReview(ctx, boardID, hex, newer, now, true)
}

func (s *Store) supersedeArtifactReview(ctx context.Context, boardID, hex string, newer []string, now time.Time, activity bool) (bool, error) {
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
	if activity {
		eligible := false
		for _, candidate := range newer {
			var active bool
			if err := tx.GetContext(ctx, &active, `SELECT EXISTS (SELECT 1 FROM artifact_tags WHERE board_id = ? AND hex = ? AND tag = ?) OR EXISTS (SELECT 1 FROM artifact_reviews WHERE board_id = ? AND hex = ? AND state IN (?, ?))`, boardID, candidate, tagForReview, boardID, candidate, ReviewApproved, ReviewDenied); err != nil {
				return false, err
			}
			eligible = eligible || active
		}
		if !eligible {
			return false, ErrNotOlderReview
		}
	}
	for _, t := range []string{tagForReview, tagRead, ReviewChangesRequested, tagSaved} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ? AND tag = ?`, boardID, hex, t); err != nil {
			return false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_questions WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil { // no longer something to review: nothing is asked (#11555)
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, ReviewSuperseded); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_reviews (board_id, hex, state, at) VALUES (?, ?, ?, ?)
		ON CONFLICT(board_id, hex) DO UPDATE SET state = excluded.state, at = excluded.at`, boardID, hex, ReviewSuperseded, now.UTC().Format(time.RFC3339)); err != nil {
		return false, err
	}
	if activity {
		if err := s.recordInTx(ctx, tx, now, ActSupersede, "file", hex, hex, boardID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	s.NoteArtifactsChanged(boardID)
	return true, nil
}

// IgnoreArtifactReview takes an artifact out of Needs you with no verdict (#11552): "for review" is replaced by "ignored" and every other tag stays (read, changes requested), so Unignore (on false) puts
// it back exactly as it was. No review row is written and the caller posts nothing. Ignoring twice changes nothing; an artifact that is not waiting for a review (or, to unignore, is not ignored) is
// ErrNotForReview.
func (s *Store) IgnoreArtifactReview(ctx context.Context, boardID, hex string, ignore bool) (ReviewChange, []string, error) {
	ch := ReviewChange{board: boardID, hex: hex}
	s.activityMu.Lock() // the chain's row is written in this transaction: one writer at a time
	defer s.activityMu.Unlock()
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
	if ignore {
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ? AND tag = ?`, boardID, hex, tagSaved); err != nil {
			return ch, nil, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, to); err != nil {
		return ch, nil, err
	}
	var tags []string
	if err := tx.SelectContext(ctx, &tags, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return ch, nil, err
	}
	s.noteActivity(ctx, tx, time.Now(), map[bool]string{true: ActIgnore, false: ActUnignore}[ignore], "file", hex, hex, boardID)
	if err := tx.Commit(); err != nil {
		return ch, nil, err
	}
	s.NoteArtifactsChanged(boardID)
	ch.Changed = true
	return ch, tags, nil
}

// SaveArtifactReview puts a file for review aside (save) or moves it back to Needs you (!save), with no verdict and nobody told (#11641): the "saved" tag is added or taken off and every other tag stays,
// "for review" included, so Approve, Changes and Deny still work on a saved file (each takes "saved" off). Saving twice, or moving back what is not saved, changes nothing; saving what is not waiting for a
// review is ErrNotForReview.
func (s *Store) SaveArtifactReview(ctx context.Context, boardID, hex string, save bool) (ReviewChange, []string, error) {
	ch := ReviewChange{board: boardID, hex: hex}
	s.activityMu.Lock() // the chain's row is written in this transaction: one writer at a time
	defer s.activityMu.Unlock()
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
	switch {
	case save && !set[tagForReview]:
		return ch, have, ErrNotForReview
	case save == set[tagSaved]:
		return ch, have, nil // already as asked
	case save && len(have) >= MaxArtifactTags:
		return ch, have, ErrArtifactTag
	case save:
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, tagSaved)
	default:
		_, err = tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ? AND tag = ?`, boardID, hex, tagSaved)
	}
	if err != nil {
		return ch, nil, err
	}
	var tags []string
	if err := tx.SelectContext(ctx, &tags, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return ch, nil, err
	}
	s.noteActivity(ctx, tx, time.Now(), map[bool]string{true: ActSave, false: ActUnsave}[save], "file", hex, hex, boardID)
	if err := tx.Commit(); err != nil {
		return ch, nil, err
	}
	s.NoteArtifactsChanged(boardID)
	ch.Changed = true
	return ch, tags, nil
}
