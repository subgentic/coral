package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// A reviewer's draft comments on a document (#21189, goal #310). A draft is the reviewer's own, on one exact version, and notifies no one: it is a row of its own table, so no read of the published comments can
// return it. The reviewer is named by the caller (the owner's issuer and subject); every method is scoped to that owner, so one reviewer's call never sees or changes another's draft.

const (
	// MaxReviewDrafts is the most drafts one reviewer holds on one version.
	MaxReviewDrafts = 40
	// ReviewDraftLocal and ReviewDraftGdoc are where a draft came from.
	ReviewDraftLocal = "local"
	ReviewDraftGdoc  = "gdoc"
)

var (
	// ErrDraftLimit is the reviewer already holding MaxReviewDrafts on this version.
	ErrDraftLimit = errors.New("too many drafts on this version")
	// ErrStaleRevision is a write made against a revision that is no longer the current one: nothing was changed.
	ErrStaleRevision = errors.New("the drafts changed since they were read")
	// ErrNoDraft is a draft that does not exist (or was sent) for this reviewer on this version.
	ErrNoDraft = errors.New("no such draft")
)

// ReviewDraft is one draft comment or reply.
type ReviewDraft struct {
	ID         int64  `db:"id" json:"id"`
	ArtifactID string `db:"artifact_id" json:"-"`
	Owner      string `db:"owner" json:"-"`
	Board      string `db:"board" json:"board"`
	ParentID   *int64 `db:"parent_id" json:"parent_id"`
	AnchorJSON string `db:"anchor_json" json:"-"`
	Body       string `db:"body" json:"body"`
	ImagesJSON string `db:"images_json" json:"-"`
	Source     string `db:"source" json:"source"`
	SourceName string `db:"source_name" json:"source_name"`
	SourceRef  string `db:"source_ref" json:"-"`
	BatchID    string `db:"batch_id" json:"-"`
	CreatedAt  string `db:"created_at" json:"created_at"`
	UpdatedAt  string `db:"updated_at" json:"updated_at"`
}

const reviewDraftCols = "id, artifact_id, owner, board, parent_id, anchor_json, body, images_json, source, source_name, source_ref, batch_id, created_at, updated_at"

type reviewTx interface {
	SelectContext(ctx context.Context, dest any, query string, args ...any) error
	GetContext(ctx context.Context, dest any, query string, args ...any) error
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// bumpReviewRevision adds one to the reviewer's revision of the version and returns the new number.
func bumpReviewRevision(ctx context.Context, tx reviewTx, artifactID, owner string) (int64, error) {
	if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_review_revisions (artifact_id, owner, revision) VALUES (?, ?, 1)
		ON CONFLICT(artifact_id, owner) DO UPDATE SET revision = revision + 1`, artifactID, owner); err != nil {
		return 0, err
	}
	var rev int64
	err := tx.GetContext(ctx, &rev, "SELECT revision FROM artifact_review_revisions WHERE artifact_id = ? AND owner = ?", artifactID, owner)
	return rev, err
}

func currentReviewRevision(ctx context.Context, tx reviewTx, artifactID, owner string) (int64, error) {
	var rev int64
	err := tx.GetContext(ctx, &rev, "SELECT revision FROM artifact_review_revisions WHERE artifact_id = ? AND owner = ?", artifactID, owner)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return rev, err
}

// ListReviewDrafts is the reviewer's pending drafts on the version, oldest first, and the current revision.
func (s *SessionStore) ListReviewDrafts(ctx context.Context, artifactID, owner string) ([]ReviewDraft, int64, error) {
	out := []ReviewDraft{}
	if err := s.reader().SelectContext(ctx, &out, "SELECT "+reviewDraftCols+" FROM artifact_review_drafts WHERE artifact_id = ? AND owner = ? AND batch_id = '' ORDER BY id", artifactID, owner); err != nil {
		return nil, 0, err
	}
	rev, err := currentReviewRevision(ctx, s.reader(), artifactID, owner)
	return out, rev, err
}

// CreateReviewDraft keeps a draft for the reviewer. The text is the caller's, already redacted; a draft needs words or pictures. The new revision is returned.
func (s *SessionStore) CreateReviewDraft(ctx context.Context, d ReviewDraft) (ReviewDraft, int64, error) {
	d.Body = strings.TrimSpace(d.Body)
	if d.Body == "" && d.ImagesJSON == "" {
		return ReviewDraft{}, 0, ErrCommentEmpty
	}
	if len(d.Body) > MaxArtifactCommentBody || len(d.AnchorJSON) > MaxArtifactCommentAnchor || len(d.ImagesJSON) > MaxArtifactCommentImages {
		return ReviewDraft{}, 0, ErrCommentTooLong
	}
	if d.Source == "" {
		d.Source = ReviewDraftLocal
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return ReviewDraft{}, 0, err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	var n int
	if err := tx.GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_review_drafts WHERE artifact_id = ? AND owner = ? AND batch_id = ''", d.ArtifactID, d.Owner); err != nil {
		return ReviewDraft{}, 0, err
	}
	if n >= MaxReviewDrafts {
		return ReviewDraft{}, 0, ErrDraftLimit
	}
	if d.ParentID != nil {
		var p struct {
			Parent  *int64  `db:"parent_id"`
			Deleted *string `db:"deleted_at"`
		}
		err := tx.GetContext(ctx, &p, "SELECT parent_id, deleted_at FROM artifact_comments WHERE id = ? AND artifact_id = ?", *d.ParentID, d.ArtifactID)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && (p.Parent != nil || p.Deleted != nil)) {
			return ReviewDraft{}, 0, ErrBadParent
		}
		if err != nil {
			return ReviewDraft{}, 0, err
		}
	}
	now := nowStamp()
	res, err := tx.ExecContext(ctx, `INSERT INTO artifact_review_drafts (artifact_id, owner, board, parent_id, anchor_json, body, images_json, source, source_name, source_ref, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.ArtifactID, d.Owner, d.Board, d.ParentID, d.AnchorJSON, d.Body, d.ImagesJSON, d.Source, d.SourceName, d.SourceRef, now, now)
	if err != nil {
		return ReviewDraft{}, 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return ReviewDraft{}, 0, err
	}
	rev, err := bumpReviewRevision(ctx, tx, d.ArtifactID, d.Owner)
	if err != nil {
		return ReviewDraft{}, 0, err
	}
	var out ReviewDraft
	if err := tx.GetContext(ctx, &out, "SELECT "+reviewDraftCols+" FROM artifact_review_drafts WHERE id = ?", id); err != nil {
		return ReviewDraft{}, 0, err
	}
	return out, rev, tx.Commit()
}

// UpdateReviewDraft changes a pending draft's words and pictures when revision is the current one. ErrStaleRevision changes nothing.
func (s *SessionStore) UpdateReviewDraft(ctx context.Context, artifactID, owner string, id int64, body, imagesJSON string, revision int64) (ReviewDraft, int64, error) {
	body = strings.TrimSpace(body)
	if body == "" && imagesJSON == "" {
		return ReviewDraft{}, 0, ErrCommentEmpty
	}
	if len(body) > MaxArtifactCommentBody || len(imagesJSON) > MaxArtifactCommentImages {
		return ReviewDraft{}, 0, ErrCommentTooLong
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return ReviewDraft{}, 0, err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	cur, err := currentReviewRevision(ctx, tx, artifactID, owner)
	if err != nil {
		return ReviewDraft{}, 0, err
	}
	var found int
	if err := tx.GetContext(ctx, &found, "SELECT COUNT(*) FROM artifact_review_drafts WHERE id = ? AND artifact_id = ? AND owner = ? AND batch_id = ''", id, artifactID, owner); err != nil {
		return ReviewDraft{}, 0, err
	}
	if found == 0 {
		return ReviewDraft{}, 0, ErrNoDraft
	}
	if cur != revision {
		return ReviewDraft{}, cur, ErrStaleRevision
	}
	if _, err := tx.ExecContext(ctx, "UPDATE artifact_review_drafts SET body = ?, images_json = ?, updated_at = ? WHERE id = ?", body, imagesJSON, nowStamp(), id); err != nil {
		return ReviewDraft{}, 0, err
	}
	rev, err := bumpReviewRevision(ctx, tx, artifactID, owner)
	if err != nil {
		return ReviewDraft{}, 0, err
	}
	var out ReviewDraft
	if err := tx.GetContext(ctx, &out, "SELECT "+reviewDraftCols+" FROM artifact_review_drafts WHERE id = ?", id); err != nil {
		return ReviewDraft{}, 0, err
	}
	return out, rev, tx.Commit()
}

// DeleteReviewDraft removes a pending draft when revision is the current one, and returns what is left and the new revision.
func (s *SessionStore) DeleteReviewDraft(ctx context.Context, artifactID, owner string, id int64, revision int64) (count int, rev int64, err error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	cur, err := currentReviewRevision(ctx, tx, artifactID, owner)
	if err != nil {
		return 0, 0, err
	}
	var found int
	if err := tx.GetContext(ctx, &found, "SELECT COUNT(*) FROM artifact_review_drafts WHERE id = ? AND artifact_id = ? AND owner = ? AND batch_id = ''", id, artifactID, owner); err != nil {
		return 0, 0, err
	}
	if found == 0 {
		return 0, 0, ErrNoDraft
	}
	if cur != revision {
		return 0, cur, ErrStaleRevision
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM artifact_review_drafts WHERE id = ?", id); err != nil {
		return 0, 0, err
	}
	if rev, err = bumpReviewRevision(ctx, tx, artifactID, owner); err != nil {
		return 0, 0, err
	}
	if err := tx.GetContext(ctx, &count, "SELECT COUNT(*) FROM artifact_review_drafts WHERE artifact_id = ? AND owner = ? AND batch_id = ''", artifactID, owner); err != nil {
		return 0, 0, err
	}
	return count, rev, tx.Commit()
}

// ReviewDraftCounts is how many pending drafts the reviewer holds on each version.
func (s *SessionStore) ReviewDraftCounts(ctx context.Context, owner string) (map[string]int, error) {
	var rows []struct {
		ArtifactID string `db:"artifact_id"`
		N          int    `db:"n"`
	}
	if err := s.reader().SelectContext(ctx, &rows, "SELECT artifact_id, COUNT(*) AS n FROM artifact_review_drafts WHERE owner = ? AND batch_id = '' GROUP BY artifact_id", owner); err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.ArtifactID] = r.N
	}
	return out, nil
}

// DeleteReviewDraftsOfArtifact drops every draft and revision of a version that is itself deleted.
func (s *SessionStore) DeleteReviewDraftsOfArtifact(ctx context.Context, artifactID string) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM artifact_review_drafts WHERE artifact_id = ?", artifactID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM artifact_review_revisions WHERE artifact_id = ?", artifactID)
	return err
}

// ReviewBatch is the record of one press of "Send comments".
type ReviewBatch struct {
	RequestID  string `db:"request_id"`
	Owner      string `db:"owner"`
	ArtifactID string `db:"artifact_id"`
	State      string `db:"state"` // ReviewBatchPrepared or ReviewBatchSent
	ResultJSON string `db:"result_json"`
	CreatedAt  string `db:"created_at"`
}

const (
	ReviewBatchPrepared = "prepared"
	ReviewBatchSent     = "sent"
)

// ErrBatchExists is a press (request id) that was already recorded.
var ErrBatchExists = errors.New("this press was already recorded")

// GetReviewBatch is the record of a press, ok false when there is none.
func (s *SessionStore) GetReviewBatch(ctx context.Context, owner, requestID string) (ReviewBatch, bool, error) {
	var b ReviewBatch
	err := s.reader().GetContext(ctx, &b, "SELECT request_id, owner, artifact_id, state, result_json, created_at FROM artifact_review_batches WHERE owner = ? AND request_id = ?", owner, requestID)
	if errors.Is(err, sql.ErrNoRows) {
		return ReviewBatch{}, false, nil
	}
	return b, err == nil, err
}

// FinishReviewBatch records the answer of a press that went out and drops the drafts it carried.
func (s *SessionStore) FinishReviewBatch(ctx context.Context, owner, requestID, artifactID, resultJSON string) (int64, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	if _, err := tx.ExecContext(ctx, "DELETE FROM artifact_review_drafts WHERE artifact_id = ? AND owner = ? AND batch_id = ?", artifactID, owner, requestID); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE artifact_review_batches SET state = ?, result_json = ? WHERE owner = ? AND request_id = ?", ReviewBatchSent, resultJSON, owner, requestID); err != nil {
		return 0, err
	}
	rev, err := bumpReviewRevision(ctx, tx, artifactID, owner)
	if err != nil {
		return 0, err
	}
	return rev, tx.Commit()
}

// PromotedComment is a draft made a published comment by PromoteReviewDrafts.
type PromotedComment struct {
	Draft   ReviewDraft
	Comment ArtifactComment
}

// PromoteReviewDrafts is the first half of a send, in one transaction: when revision is the current one, the reviewer's pending drafts on the version become published comments (a reply goes in its thread), the
// drafts are marked as carried by the press, and the press is recorded as prepared. author names the owner on the comments. ErrNoDraft when there is nothing to send, ErrStaleRevision when the drafts
// changed, ErrBatchExists when the press was already recorded. Nothing is delivered here.
func (s *SessionStore) PromoteReviewDrafts(ctx context.Context, artifactID, owner, requestID string, revision int64, author ArtifactComment) ([]PromotedComment, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	cur, err := currentReviewRevision(ctx, tx, artifactID, owner)
	if err != nil {
		return nil, err
	}
	if cur != revision {
		return nil, ErrStaleRevision
	}
	var drafts []ReviewDraft
	if err := tx.SelectContext(ctx, &drafts, "SELECT "+reviewDraftCols+" FROM artifact_review_drafts WHERE artifact_id = ? AND owner = ? AND batch_id = '' ORDER BY id", artifactID, owner); err != nil {
		return nil, err
	}
	if len(drafts) == 0 {
		return nil, ErrNoDraft
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO artifact_review_batches (request_id, owner, artifact_id, state, created_at) VALUES (?, ?, ?, ?, ?)", requestID, owner, artifactID, ReviewBatchPrepared, nowStamp()); err != nil {
		var dup int
		if e2 := tx.GetContext(ctx, &dup, "SELECT COUNT(*) FROM artifact_review_batches WHERE owner = ? AND request_id = ?", owner, requestID); e2 == nil && dup > 0 {
			return nil, ErrBatchExists
		}
		return nil, err
	}
	var n int
	if err := tx.GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_comments WHERE artifact_id = ? AND deleted_at IS NULL", artifactID); err != nil {
		return nil, err
	}
	if n+len(drafts) > MaxArtifactComments {
		return nil, ErrTooManyComments
	}
	out := make([]PromotedComment, 0, len(drafts))
	for _, d := range drafts {
		parent := d.ParentID
		if parent != nil {
			var p struct {
				Parent  *int64  `db:"parent_id"`
				Deleted *string `db:"deleted_at"`
			}
			err := tx.GetContext(ctx, &p, "SELECT parent_id, deleted_at FROM artifact_comments WHERE id = ? AND artifact_id = ?", *parent, artifactID)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && (p.Parent != nil || p.Deleted != nil)) {
				return nil, ErrBadParent // the thread was deleted since the draft was written: nothing is sent
			}
			if err != nil {
				return nil, err
			}
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO artifact_comments (artifact_id, board, parent_id, anchor_json, body, author_issuer, author_subject, author_name, author_kind, created_at, images_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			artifactID, d.Board, parent, d.AnchorJSON, d.Body, author.AuthorIssuer, author.AuthorSubject, author.AuthorName, author.AuthorKind, nowStamp(), d.ImagesJSON)
		if err != nil {
			return nil, err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return nil, err
		}
		var c ArtifactComment
		if err := tx.GetContext(ctx, &c, "SELECT "+artifactCommentCols+" FROM artifact_comments WHERE id = ?", id); err != nil {
			return nil, err
		}
		out = append(out, PromotedComment{Draft: d, Comment: c})
	}
	if _, err := tx.ExecContext(ctx, "UPDATE artifact_review_drafts SET batch_id = ? WHERE artifact_id = ? AND owner = ? AND batch_id = ''", requestID, artifactID, owner); err != nil {
		return nil, err
	}
	if _, err := bumpReviewRevision(ctx, tx, artifactID, owner); err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

// UndoReviewBatch takes back a press that reached no one: its comments are deleted, its drafts are pending again and the record of the press goes, so the person can press again.
func (s *SessionStore) UndoReviewBatch(ctx context.Context, artifactID, owner, requestID string, commentIDs []int64) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	for _, id := range commentIDs {
		if _, err := tx.ExecContext(ctx, "DELETE FROM artifact_comments WHERE id = ? AND artifact_id = ?", id, artifactID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM artifact_comment_asks WHERE comment_id = ?", id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE artifact_review_drafts SET batch_id = '' WHERE artifact_id = ? AND owner = ? AND batch_id = ?", artifactID, owner, requestID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM artifact_review_batches WHERE owner = ? AND request_id = ?", owner, requestID); err != nil {
		return err
	}
	if _, err := bumpReviewRevision(ctx, tx, artifactID, owner); err != nil {
		return err
	}
	return tx.Commit()
}
