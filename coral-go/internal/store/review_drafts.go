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
