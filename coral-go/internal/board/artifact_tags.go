package board

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/jmoiron/sqlx"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// Artifact tags (#8583, Goal #61): short lowercase words a team puts on its artifacts to find the ones that matter ("for review", "internal"). A tag belongs to a team's use of a stored object (board,
// object id), so another team that holds the same bytes has its own. Letters, digits, spaces and hyphens, 1 to 24 characters, at most 5 on an artifact; normalised on save.

const (
	MaxArtifactTags = 5
	// MaxBoardArtifactTagRows bounds the tag rows of one board: AddArtifactTags (a manifest, an upload) names an object by its id without checking that it exists, so the rows are bounded here.
	MaxBoardArtifactTagRows = 5000
	MaxArtifactTagLen       = 24
)

// StarterArtifactTags are the four tags the UI offers first.
var StarterArtifactTags = []string{"for review", "internal", "final", "draft"}

// ErrArtifactTag is a tag (or a set of them) that is refused.
var ErrArtifactTag = errors.New("invalid artifact tag")

// NormalizeArtifactTag is a tag as it is stored: trimmed, lower-cased, runs of white space (the Unicode White_Space set) made one space; ok is false for one that is empty, over MaxArtifactTagLen characters, or holds anything but
// letters, digits, spaces and hyphens.
func NormalizeArtifactTag(s string) (string, bool) {
	// Lower-casing is per character and locale-free, with no final-sigma context, as the dashboard does it; the one character whose full lower case is two characters (capital I with a dot, which
	// JavaScript makes i and a combining dot) is refused on both sides rather than made "i" here (#8680).
	if strings.ContainsRune(s, '\u0130') {
		return "", false
	}
	s = strings.ToLower(strings.Join(strings.Fields(s), " "))
	n := 0
	for _, r := range s {
		n++
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-') {
			return "", false
		}
	}
	if n == 0 || n > MaxArtifactTagLen {
		return "", false
	}
	return s, true
}

// NormalizeArtifactTags is a set of tags as they are stored, or an error naming the first that is refused: each normalised, repeats once, in the order given, at most MaxArtifactTags.
func NormalizeArtifactTags(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		tag, ok := NormalizeArtifactTag(raw)
		if !ok {
			return nil, fmt.Errorf("%w: %q (1 to %d letters, digits, spaces or hyphens)", ErrArtifactTag, raw, MaxArtifactTagLen)
		}
		if !seen[tag] {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	if len(out) > MaxArtifactTags {
		return nil, fmt.Errorf("%w: at most %d tags on an artifact", ErrArtifactTag, MaxArtifactTags)
	}
	return out, nil
}

// operatorArtifactTags are the tags that are the Operator's word (#11645): "read", "ignored", "saved" and "denied" are set by a click, and "approved", "changes requested" and "superseded" by a decision (or a newer version).
// Needs you and the review rows read them, so an agent that could write them would keep its own file out of Needs you or show a decision nobody made. Only the Operator's routes and the review code set them.
var operatorArtifactTags = map[string]bool{"read": true, "ignored": true, "saved": true, "denied": true, "approved": true, "changes requested": true, "superseded": true}

// OperatorArtifactTag says the tag, as an agent might spell it, is one of the Operator's states.
func OperatorArtifactTag(s string) bool {
	tag, ok := NormalizeArtifactTag(s)
	return ok && operatorArtifactTags[tag]
}

// CleanArtifactTags is NormalizeArtifactTags for tags an agent sent: one that is refused is dropped, and those past MaxArtifactTags are left off, so a tag never stops an upload or a result. The Operator's own states
// (OperatorArtifactTag) are dropped too: an agent never sets them.
func CleanArtifactTags(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		if tag, ok := NormalizeArtifactTag(raw); ok && !seen[tag] && !operatorArtifactTags[tag] && len(out) < MaxArtifactTags {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	return out
}

func (s *Store) ensureArtifactTagsSchema(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS artifact_tags (
			board_id TEXT NOT NULL,
			hex      TEXT NOT NULL,
			tag      TEXT NOT NULL,
			PRIMARY KEY (board_id, hex, tag)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_artifact_tags_board_tag ON artifact_tags(board_id, tag)`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

// ArtifactTags maps each tagged stored object of the board (its 64-hex id) to its tags, sorted.
func (s *Store) ArtifactTags(ctx context.Context, boardID string) (map[string][]string, error) {
	var rows []struct {
		Hex string `db:"hex"`
		Tag string `db:"tag"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT hex, tag FROM artifact_tags WHERE board_id = ? ORDER BY hex, tag`, boardID); err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, r := range rows {
		out[r.Hex] = append(out[r.Hex], r.Tag)
	}
	for _, tags := range out {
		sort.Strings(tags)
	}
	return out, nil
}

// SetArtifactTags makes tags (already normalised, at most MaxArtifactTags) the whole set of the object's tags on the board.
func (s *Store) SetArtifactTags(ctx context.Context, boardID, hex string, tags []string) error {
	return s.setArtifactTags(ctx, boardID, hex, tags, nil, false, "")
}

// ErrArtifactTagsChanged: the tags of the object are not what the caller read, so a write built on that read was not made (#13129).
var ErrArtifactTagsChanged = errors.New("the artifact's tags changed since they were read")

// SetArtifactTagsIf is SetArtifactTags as a compare-and-set (#13129): the write is made only if the object's tags, read in the same transaction, are exactly was (as a set); otherwise nothing is written and the
// error is ErrArtifactTagsChanged. A write that was worked out from a list read earlier (a Hub write judged against the stored tags) can therefore never overwrite a tag edit that landed in between.
func (s *Store) SetArtifactTagsIf(ctx context.Context, boardID, hex string, was, tags []string) error {
	return s.setArtifactTags(ctx, boardID, hex, tags, was, true, "")
}

// TakeArtifactOutOfReview is SetArtifactTagsIf for the Operator taking a file out of review (#13231): the write and its row in the Operator's record (ActUnsendReview, when ctx says the Operator acted) are one
// transaction, so a row that cannot be written undoes the take-out and the caller says so.
func (s *Store) TakeArtifactOutOfReview(ctx context.Context, boardID, hex string, was, tags []string) error {
	s.activityMu.Lock() // the record's chain is written in this transaction: one writer at a time
	defer s.activityMu.Unlock()
	return s.setArtifactTags(ctx, boardID, hex, tags, was, true, ActUnsendReview)
}

func (s *Store) setArtifactTags(ctx context.Context, boardID, hex string, tags, was []string, check bool, record string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var have []string
	if err := tx.SelectContext(ctx, &have, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return err
	}
	if check {
		if !sameTagSet(have, was) {
			return ErrArtifactTagsChanged
		}
		tagsCASAfterRead()
	}
	if err := noteReviewTag(ctx, tx, boardID, hex, slices.Contains(have, tagForReview), slices.Contains(tags, tagForReview), time.Now()); err != nil { // when it was sent for review (#13231)
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil {
		return tagsWriteErr(check, err) // a writer committed after this transaction's read: the snapshot is stale, which is the same answer as a changed list (#13138)
	}
	if !slices.Contains(tags, tagForReview) { // the tag is gone: the question it came with goes too (#11555)
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_questions WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil {
			return err
		}
	}
	for _, tag := range tags {
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, tag); err != nil {
			return err
		}
	}
	if record != "" {
		if err := s.recordInTx(ctx, tx, time.Now(), record, "file", hex, "", boardID); err != nil {
			return err // the take-out and its row stand or fall together
		}
	}
	if err := commitArtifactTagsTx(tx); err != nil {
		return tagsWriteErr(check, err)
	}
	s.NoteArtifactsChanged(boardID)
	return nil
}

// commitArtifactTagsTx commits the tags transaction; a variable so a test can make the commit answer busy.
var commitArtifactTagsTx = func(tx *sqlx.Tx) error { return tx.Commit() }

// tagsWriteErr is the answer for a failed write of the tags: for a compare-and-set (check) a SQLite busy is "the tags changed" (the caller retries); every other write, and every other error, keeps its own.
func tagsWriteErr(check bool, err error) error {
	if check && isSQLiteBusy(err) {
		return ErrArtifactTagsChanged
	}
	return err
}

// tagsCASAfterRead is a seam for a test: it runs inside SetArtifactTagsIf once its read matched, before the write.
var tagsCASAfterRead = func() {}

// isSQLiteBusy says err is SQLite's busy or locked answer (including the stale-snapshot kind a deferred transaction gets when it upgrades to a write after another writer committed).
func isSQLiteBusy(err error) bool {
	var se *sqlite.Error
	if errors.As(err, &se) {
		switch se.Code() & 0xff {
		case sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED:
			return true
		}
	}
	return false
}

// sameTagSet says a and b hold the same tags, whatever their order or repeats.
func sameTagSet(a, b []string) bool {
	in := map[string]bool{}
	for _, t := range a {
		in[t] = true
	}
	seen := map[string]bool{}
	for _, t := range b {
		if !in[t] {
			return false
		}
		seen[t] = true
	}
	return len(seen) == len(in)
}

// AddArtifactTags adds tags (already cleaned) to the object's tags on the board, up to MaxArtifactTags in all and MaxBoardArtifactTagRows on the board: what is over is left off. It reports the object's tags after.
func (s *Store) AddArtifactTags(ctx context.Context, boardID, hex string, add []string) ([]string, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var have []string
	if err := tx.SelectContext(ctx, &have, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return nil, err
	}
	hadReview := slices.Contains(have, tagForReview)
	var rows int
	if err := tx.GetContext(ctx, &rows, `SELECT COUNT(*) FROM artifact_tags WHERE board_id = ?`, boardID); err != nil {
		return nil, err
	}
	set := map[string]bool{}
	for _, t := range have {
		set[t] = true
	}
	for _, tag := range add {
		if len(have) >= MaxArtifactTags || rows >= MaxBoardArtifactTagRows {
			break
		}
		if !set[tag] {
			rows++
			set[tag] = true
			have = append(have, tag)
			if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, tag); err != nil {
				return nil, err
			}
		}
	}
	if err := noteReviewTag(ctx, tx, boardID, hex, hadReview, slices.Contains(have, tagForReview), time.Now()); err != nil { // when it was sent for review (#13231)
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.NoteArtifactsChanged(boardID)
	sort.Strings(have)
	return have, nil
}
