package store

import (
	"context"
	"time"
)

// An agent's reply in a thread the Operator started is news for them until they open the thread (#12026, the Operator): the file's row says "New comments". artifact_comment_seen holds, per thread, when the
// owner last opened it.

// CommentReply is one thread the owner started that an agent has replied in since the owner last opened it: the thread (its first comment), the artifact and board it is on, the agent that replied last, when,
// and how many replies are unseen.
type CommentReply struct {
	RootID     int64  `db:"root_id"`
	ArtifactID string `db:"artifact_id"`
	Board      string `db:"board"`
	Agent      string `db:"agent"`
	At         string `db:"at"`
	Count      int    `db:"n"`
}

// UnseenAgentReplies lists the owner's threads with agent replies newer than the owner's last opening of them, one row per thread, by artifact and thread. A reply by anyone else, a deleted reply, a thread a hub viewer
// or an agent started, and a deleted thread are not news for the Operator.
func (s *SessionStore) UnseenAgentReplies(ctx context.Context) ([]CommentReply, error) {
	var out []CommentReply
	err := s.reader().SelectContext(ctx, &out, `
		SELECT c.id AS root_id, c.artifact_id AS artifact_id, c.board AS board,
		       (SELECT r2.author_name FROM artifact_comments r2 WHERE r2.parent_id = c.id AND r2.author_kind = 'agent' AND r2.deleted_at IS NULL ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1) AS agent,
		       MAX(r.created_at) AS at, COUNT(*) AS n
		FROM artifact_comments r
		JOIN artifact_comments c ON c.id = r.parent_id
		LEFT JOIN artifact_comment_seen s ON s.comment_id = c.id
		WHERE r.author_kind = 'agent' AND r.deleted_at IS NULL
		  AND c.author_kind = 'owner' AND c.parent_id IS NULL AND c.deleted_at IS NULL
		  AND (s.seen_at IS NULL OR r.created_at > s.seen_at)
		GROUP BY c.id
		ORDER BY c.artifact_id, c.id`)
	return out, err
}

// MarkThreadsSeen records that the owner opened the threads of an artifact: every thread the owner started on it is seen as of now.
func (s *SessionStore) MarkThreadsSeen(ctx context.Context, artifactID string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO artifact_comment_seen (comment_id, seen_at)
		SELECT id, ? FROM artifact_comments WHERE artifact_id = ? AND author_kind = 'owner' AND parent_id IS NULL
		ON CONFLICT(comment_id) DO UPDATE SET seen_at = excluded.seen_at`, now.UTC().Format(ISOFormat), artifactID)
	return err
}
