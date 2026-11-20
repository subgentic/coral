package store

// Share to Google Docs (#19996, slice B of #20010): the Docs an artifact series was shared to. Nothing here calls Google.

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Sync states of a shared Doc: the owner's per-Doc pause is the second.
const (
	GdocShareLive   = "live"
	GdocSharePaused = "paused"
)

// GdocShare is one shared Doc. Key is the artifact's series id, or its digest when it has no series.
type GdocShare struct {
	Key         string `db:"key" json:"key"`
	DocID       string `db:"doc_id" json:"doc_id"`
	Digest      string `db:"digest" json:"digest"`
	Name        string `db:"name" json:"name"`
	State       string `db:"state" json:"state"`
	DocRevision string `db:"doc_revision" json:"-"`
	ConflictDoc string `db:"conflict_doc_id" json:"conflict_doc_id,omitempty"`
	CreatedAt   string `db:"created_at" json:"created_at"`
	SyncedAt    string `db:"synced_at" json:"synced_at,omitempty"`
}

const gdocShareCols = "key, doc_id, digest, name, state, doc_revision, conflict_doc_id, created_at, synced_at"

// GetGdocShare returns the share for key, or (nil, nil) when there is none.
func (s *SessionStore) GetGdocShare(ctx context.Context, key string) (*GdocShare, error) {
	var g GdocShare
	err := s.reader().GetContext(ctx, &g, "SELECT "+gdocShareCols+" FROM gdoc_shares WHERE key = ?", key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// ListGdocShares returns every share, oldest first (the sync loop's worklist).
func (s *SessionStore) ListGdocShares(ctx context.Context) ([]GdocShare, error) {
	var out []GdocShare
	if err := s.reader().SelectContext(ctx, &out, "SELECT "+gdocShareCols+" FROM gdoc_shares ORDER BY created_at, key"); err != nil {
		return nil, err
	}
	return out, nil
}

// SaveGdocShare adds the share or updates it (the Doc, the version pushed, the revision and the time of the sync); a new row starts live, and an update keeps the state.
func (s *SessionStore) SaveGdocShare(ctx context.Context, g GdocShare, now time.Time) error {
	if g.Key == "" || g.DocID == "" {
		return errors.New("a Google Doc share needs a key and a Doc")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO gdoc_shares (key, doc_id, digest, name, state, doc_revision, conflict_doc_id, created_at, synced_at) VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET doc_id = excluded.doc_id, digest = excluded.digest, name = excluded.name, doc_revision = excluded.doc_revision, conflict_doc_id = excluded.conflict_doc_id, synced_at = excluded.synced_at`,
		g.Key, g.DocID, g.Digest, g.Name, g.DocRevision, g.ConflictDoc, now.UTC().Format(time.RFC3339), g.SyncedAt)
	return err
}

// SetGdocShareState pauses or resumes a share; false when there is none.
func (s *SessionStore) SetGdocShareState(ctx context.Context, key, state string) (bool, error) {
	if state != GdocShareLive && state != GdocSharePaused {
		return false, errors.New("not a share state")
	}
	res, err := s.db.ExecContext(ctx, "UPDATE gdoc_shares SET state = ? WHERE key = ?", state, key)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// DeleteGdocShare removes a share (Unshare): the Doc stays in Google, Coral stops syncing it. False when there was none.
func (s *SessionStore) DeleteGdocShare(ctx context.Context, key string) (bool, error) {
	res, err := s.db.ExecContext(ctx, "DELETE FROM gdoc_shares WHERE key = ?", key)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// GdocCommentRow says that Coral comment CommentID mirrors the Google comment (or reply) RemoteID of a Doc.
type GdocCommentRow struct {
	DocID     string `db:"doc_id"`
	RemoteID  string `db:"remote_id"`
	CommentID int64  `db:"comment_id"`
	Resolved  bool   `db:"resolved"`
}

// GdocCommentMap returns what is already mirrored for a Doc, by remote id.
func (s *SessionStore) GdocCommentMap(ctx context.Context, docID string) (map[string]GdocCommentRow, error) {
	var rows []GdocCommentRow
	if err := s.reader().SelectContext(ctx, &rows, "SELECT doc_id, remote_id, comment_id, resolved FROM gdoc_comment_map WHERE doc_id = ?", docID); err != nil {
		return nil, err
	}
	out := make(map[string]GdocCommentRow, len(rows))
	for _, r := range rows {
		out[r.RemoteID] = r
	}
	return out, nil
}

// SaveGdocComment records (or updates) the mirror of one Google comment or reply.
func (s *SessionStore) SaveGdocComment(ctx context.Context, r GdocCommentRow) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO gdoc_comment_map (doc_id, remote_id, comment_id, resolved) VALUES (?, ?, ?, ?)
		ON CONFLICT(doc_id, remote_id) DO UPDATE SET comment_id = excluded.comment_id, resolved = excluded.resolved`, r.DocID, r.RemoteID, r.CommentID, r.Resolved)
	return err
}
