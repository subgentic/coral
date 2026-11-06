package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Send to agent (#6357): the owner asks one agent into one comment's thread, and the agent may reply only into a thread it was asked into.

// The limits of an ask, enforced here whatever calls it.
const (
	AskTTL           = 24 * time.Hour // an ask is open this long
	MaxAskReplies    = 5              // replies one agent may leave in one asked thread
	MaxAskReplyBytes = 8 << 10        // bytes in one reply
)

var (
	// ErrAskNone: the agent was never asked into this thread.
	ErrAskNone = errors.New("this agent was not asked into that thread")
	// ErrAskClosed: the ask ended (closed or expired).
	ErrAskClosed = errors.New("the ask has ended")
	// ErrAskReplyCap: the agent has left all the replies it may.
	ErrAskReplyCap = errors.New("the agent has left the most replies it may in that thread")
	// ErrAskReplyTooBig: a reply over MaxAskReplyBytes.
	ErrAskReplyTooBig = errors.New("the reply is too long")
)

// ArtifactAsk is one agent asked into one comment's thread.
type ArtifactAsk struct {
	ID           int64   `db:"id" json:"id"`
	CommentID    int64   `db:"comment_id" json:"comment_id"`
	ArtifactID   string  `db:"artifact_id" json:"artifact_id"`
	Board        string  `db:"board" json:"board"`
	AgentSession string  `db:"agent_session" json:"agent_session"`
	AgentName    string  `db:"agent_name" json:"agent_name"`
	CreatedAt    string  `db:"created_at" json:"created_at"`
	ExpiresAt    string  `db:"expires_at" json:"expires_at"`
	ClosedAt     *string `db:"closed_at" json:"closed_at"`
	Replies      int     `db:"replies" json:"replies"`
	// SeenAt is when the agent first read the artifact's threads or replied, NudgedAt when Coral reminded it to answer in the thread (#11722).
	SeenAt   *string `db:"seen_at" json:"seen_at"`
	NudgedAt *string `db:"nudged_at" json:"nudged_at"`
}

const artifactAskCols = "id, comment_id, artifact_id, board, agent_session, agent_name, created_at, expires_at, closed_at, replies, seen_at, nudged_at"

func (a ArtifactAsk) open(now time.Time) bool {
	if a.ClosedAt != nil {
		return false
	}
	exp, err := time.Parse(ISOFormat, a.ExpiresAt)
	return err == nil && now.Before(exp)
}

// Times are stored as ISOFormat, fixed width, so the SQL comparison with now (expires_at > ?) is exact.
// OpenAt is true while the ask is open at now.
func (a ArtifactAsk) OpenAt(now time.Time) bool { return a.open(now) }

// CreateArtifactAsk asks agentSession into the comment's thread, in one write: an ask still open for the same (comment, agent) is returned as it is with created false (a double click
// delivers once); one that ended or expired starts anew. The decision and the write are one transaction, so two requests at once make one ask between them.
func (s *SessionStore) CreateArtifactAsk(ctx context.Context, commentID int64, artifactID, board, agentSession, agentName string, now time.Time) (ask ArtifactAsk, created bool, err error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return ArtifactAsk{}, false, err
	}
	defer tx.Rollback()
	var cur ArtifactAsk
	err = tx.GetContext(ctx, &cur, "SELECT "+artifactAskCols+" FROM artifact_comment_asks WHERE comment_id = ? AND agent_session = ?", commentID, agentSession)
	switch {
	case err == nil && cur.open(now):
		return cur, false, tx.Commit()
	case err == nil:
		_, err = tx.ExecContext(ctx, `UPDATE artifact_comment_asks SET artifact_id = ?, board = ?, agent_name = ?, created_at = ?, expires_at = ?, closed_at = NULL, replies = 0, seen_at = NULL, nudged_at = NULL WHERE id = ?`,
			artifactID, board, agentName, now.UTC().Format(ISOFormat), now.Add(AskTTL).UTC().Format(ISOFormat), cur.ID)
	case errors.Is(err, sql.ErrNoRows):
		_, err = tx.ExecContext(ctx, `INSERT INTO artifact_comment_asks (comment_id, artifact_id, board, agent_session, agent_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			commentID, artifactID, board, agentSession, agentName, now.UTC().Format(ISOFormat), now.Add(AskTTL).UTC().Format(ISOFormat))
	}
	if err != nil {
		return ArtifactAsk{}, false, err
	}
	if err := tx.GetContext(ctx, &cur, "SELECT "+artifactAskCols+" FROM artifact_comment_asks WHERE comment_id = ? AND agent_session = ?", commentID, agentSession); err != nil {
		return ArtifactAsk{}, false, err
	}
	return cur, true, tx.Commit()
}

// GetArtifactAsk reads the ask of (comment, agent session).
func (s *SessionStore) GetArtifactAsk(ctx context.Context, commentID int64, agentSession string) (ArtifactAsk, bool, error) {
	var a ArtifactAsk
	err := s.reader().GetContext(ctx, &a, "SELECT "+artifactAskCols+" FROM artifact_comment_asks WHERE comment_id = ? AND agent_session = ?", commentID, agentSession)
	if errors.Is(err, sql.ErrNoRows) {
		return ArtifactAsk{}, false, nil
	}
	return a, err == nil, err
}

// ReserveAskReply is the one atomic check of an agent's reply into a thread (#6357): the ask must exist, be open and not expired, and be under its reply cap, and the reply under its size; the
// count is taken in the same statement that checks it, so replies arriving together cannot pass the cap between them. A nil error means one reply is counted for the agent. A reply that then
// fails to be stored is given back with ReleaseAskReply.
func (s *SessionStore) ReserveAskReply(ctx context.Context, commentID int64, agentSession string, replyBytes int, now time.Time) error {
	if replyBytes > MaxAskReplyBytes {
		return ErrAskReplyTooBig
	}
	res, err := s.db.ExecContext(ctx, `UPDATE artifact_comment_asks SET replies = replies + 1, seen_at = COALESCE(seen_at, ?) WHERE comment_id = ? AND agent_session = ? AND closed_at IS NULL AND expires_at > ? AND replies < ?`,
		now.UTC().Format(ISOFormat), commentID, agentSession, now.UTC().Format(ISOFormat), MaxAskReplies)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		return nil
	}
	a, found, err := s.GetArtifactAsk(ctx, commentID, agentSession)
	switch {
	case err != nil:
		return err
	case !found:
		return ErrAskNone
	case !a.open(now):
		return ErrAskClosed
	}
	return ErrAskReplyCap
}

// ReleaseAskReply gives back a reply ReserveAskReply counted that was not stored.
func (s *SessionStore) ReleaseAskReply(ctx context.Context, commentID int64, agentSession string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE artifact_comment_asks SET replies = replies - 1 WHERE comment_id = ? AND agent_session = ? AND replies > 0`, commentID, agentSession)
}

// CloseArtifactAsks ends the open asks of a comment (the comment was resolved or deleted).
func (s *SessionStore) CloseArtifactAsks(ctx context.Context, commentID int64, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_comment_asks SET closed_at = ? WHERE comment_id = ? AND closed_at IS NULL`, now.UTC().Format(ISOFormat), commentID)
	return err
}

// DeleteAsksOfArtifact drops every ask of an artifact (the artifact was deleted).
func (s *SessionStore) DeleteAsksOfArtifact(ctx context.Context, artifactID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM artifact_comment_asks WHERE artifact_id = ?`, artifactID)
	return err
}

// CloseArtifactAsk ends one agent's ask of a comment (its message could not be delivered).
func (s *SessionStore) CloseArtifactAsk(ctx context.Context, commentID int64, agentSession string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_comment_asks SET closed_at = ? WHERE comment_id = ? AND agent_session = ? AND closed_at IS NULL`, now.UTC().Format(ISOFormat), commentID, agentSession)
	return err
}

// DeleteArtifactAsk takes one agent's ask of a comment away altogether (#13802): a message that could not be posted leaves no row behind, so a retry is a first send and not "already sent".
func (s *SessionStore) DeleteArtifactAsk(ctx context.Context, commentID int64, agentSession string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM artifact_comment_asks WHERE comment_id = ? AND agent_session = ?`, commentID, agentSession)
	return err
}

// ListArtifactAsks are the asks of an artifact's comments, oldest first (the owner's comment list shows them).
func (s *SessionStore) ListArtifactAsks(ctx context.Context, artifactID string) ([]ArtifactAsk, error) {
	var out []ArtifactAsk
	err := s.reader().SelectContext(ctx, &out, "SELECT "+artifactAskCols+" FROM artifact_comment_asks WHERE artifact_id = ? ORDER BY id", artifactID)
	return out, err
}

// HasArtifactAsk says whether the agent session was ever asked into a thread of this artifact (open or ended): what lets an agent that did not upload it read its threads.
func (s *SessionStore) HasArtifactAsk(ctx context.Context, artifactID, agentSession string) (bool, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_comment_asks WHERE artifact_id = ? AND agent_session = ? LIMIT 1", artifactID, agentSession)
	return n > 0, err
}

// MarkAsksSeen records that the agent session read the threads of the artifact: the first time, on each of its open asks (#11722). The owner's thread then says "seen by <agent>".
func (s *SessionStore) MarkAsksSeen(ctx context.Context, artifactID, agentSession string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_comment_asks SET seen_at = ? WHERE artifact_id = ? AND agent_session = ? AND closed_at IS NULL AND seen_at IS NULL`, now.UTC().Format(ISOFormat), artifactID, agentSession)
	return err
}

// AwaitingAsks are the asks still open at now that the agent has not answered (no reply in the thread) and that Coral has not reminded it about, oldest first, at most limit (#11722). Only asks of a session that is
// live, awake and not archived: an agent that sleeps or is gone cannot be typed into, and its asks must not fill the batch and starve newer ones.
func (s *SessionStore) AwaitingAsks(ctx context.Context, now time.Time, limit int) ([]ArtifactAsk, error) {
	var out []ArtifactAsk
	err := s.reader().SelectContext(ctx, &out, "SELECT "+artifactAskCols+` FROM artifact_comment_asks WHERE closed_at IS NULL AND expires_at > ? AND replies = 0 AND nudged_at IS NULL
		AND agent_session IN (SELECT session_id FROM live_sessions WHERE COALESCE(is_archived, 0) = 0 AND COALESCE(is_sleeping, 0) = 0 AND agent_type != 'terminal') ORDER BY id LIMIT ?`, now.UTC().Format(ISOFormat), limit)
	return out, err
}

// MarkAskNudged records that Coral reminded the agent to answer in the thread, once: a second call changes nothing and says so (false).
func (s *SessionStore) MarkAskNudged(ctx context.Context, askID int64, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE artifact_comment_asks SET nudged_at = ? WHERE id = ? AND nudged_at IS NULL AND replies = 0 AND closed_at IS NULL`, now.UTC().Format(ISOFormat), askID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// ClearAskNudged takes back MarkAskNudged for a reminder that could not be typed, so the next pass tries it again (#11722).
func (s *SessionStore) ClearAskNudged(ctx context.Context, askID int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_comment_asks SET nudged_at = NULL WHERE id = ? AND replies = 0`, askID)
	return err
}
