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
	RootID     int64
	ArtifactID string
	Board      string
	Agent      string
	At         string
	Count      int
}

// UnseenAgentReplies lists the owner's threads with agent replies newer than the owner's last opening of them, one row per thread, by artifact and thread. A reply by anyone else, a deleted reply, a thread a hub viewer
// or an agent started, and a deleted thread are not news for the Operator. The times are compared here, as times: the comments' created_at is RFC 3339 text of varying length, which SQL must not order or compare.
func (s *SessionStore) UnseenAgentReplies(ctx context.Context) ([]CommentReply, error) {
	var rows []struct {
		ID         int64   `db:"id"`
		RootID     int64   `db:"root_id"`
		ArtifactID string  `db:"artifact_id"`
		Board      string  `db:"board"`
		Agent      string  `db:"agent"`
		At         string  `db:"at"`
		SeenAt     *string `db:"seen_at"`
	}
	err := s.reader().SelectContext(ctx, &rows, `
		SELECT r.id AS id, c.id AS root_id, c.artifact_id AS artifact_id, c.board AS board, r.author_name AS agent, r.created_at AS at, s.seen_at AS seen_at
		FROM artifact_comments r
		JOIN artifact_comments c ON c.id = r.parent_id
		LEFT JOIN artifact_comment_seen s ON s.comment_id = c.id
		WHERE r.author_kind = 'agent' AND r.deleted_at IS NULL
		  AND c.author_kind = 'owner' AND c.parent_id IS NULL AND c.deleted_at IS NULL
		ORDER BY c.artifact_id, c.id, r.id`)
	if err != nil {
		return nil, err
	}
	var out []CommentReply
	byRoot := map[int64]int{} // root id -> its index in out
	newest := map[int64]time.Time{}
	for _, r := range rows {
		at, err := time.Parse(time.RFC3339Nano, r.At)
		if err != nil {
			continue
		}
		if r.SeenAt != nil {
			if seen, err := time.Parse(time.RFC3339Nano, *r.SeenAt); err == nil && !at.After(seen) {
				continue // opened since
			}
		}
		i, ok := byRoot[r.RootID]
		if !ok {
			i = len(out)
			byRoot[r.RootID] = i
			out = append(out, CommentReply{RootID: r.RootID, ArtifactID: r.ArtifactID, Board: r.Board})
		}
		out[i].Count++
		if t, seen := newest[r.RootID]; !seen || !at.Before(t) { // the newest reply names the thread (a tie goes to the later one)
			newest[r.RootID] = at
			out[i].Agent, out[i].At = r.Agent, r.At
		}
	}
	return out, nil
}

// MarkThreadsSeen records the owner's read, preserving the error-only API for
// callers that do not need to invalidate a list.
func (s *SessionStore) MarkThreadsSeen(ctx context.Context, artifactID string, now time.Time) error {
	_, err := s.MarkThreadsSeenChanged(ctx, artifactID, now)
	return err
}

// MarkThreadsSeenChanged reports whether this read cleared any unread agent
// replies. Repeated polls do no writes and must not invalidate artifact lists.
// Read and write share a transaction so two readers cannot both claim the same
// change, or swallow a reply inserted between checking and marking it seen.
func (s *SessionStore) MarkThreadsSeenChanged(ctx context.Context, artifactID string, now time.Time) (bool, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var rows []struct {
		RootID int64   `db:"root_id"`
		At     string  `db:"at"`
		SeenAt *string `db:"seen_at"`
	}
	if err := tx.SelectContext(ctx, &rows, `
  SELECT c.id AS root_id, r.created_at AS at, s.seen_at AS seen_at
  FROM artifact_comments c
  JOIN artifact_comments r ON r.parent_id = c.id
  LEFT JOIN artifact_comment_seen s ON s.comment_id = c.id
  WHERE c.artifact_id = ? AND c.author_kind = 'owner'
   AND c.parent_id IS NULL AND c.deleted_at IS NULL
   AND r.author_kind = 'agent' AND r.deleted_at IS NULL`, artifactID); err != nil {
		return false, err
	}
	// ISOFormat stores microseconds: only a reply at/before the stored cutoff can
	// actually become seen. Compare parsed times, never varying RFC3339 strings.
	cutoff := now.UTC().Truncate(time.Microsecond)
	roots := map[int64]bool{}
	for _, r := range rows {
		at, err := time.Parse(time.RFC3339Nano, r.At)
		if err != nil || at.After(cutoff) {
			continue
		}
		if r.SeenAt != nil {
			if seen, err := time.Parse(time.RFC3339Nano, *r.SeenAt); err == nil && !at.After(seen) {
				continue
			}
		}
		roots[r.RootID] = true
	}
	if len(roots) == 0 {
		return false, nil
	}
	for id := range roots {
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_comment_seen (comment_id, seen_at) VALUES (?, ?)
   ON CONFLICT(comment_id) DO UPDATE SET seen_at = excluded.seen_at`, id, cutoff.Format(ISOFormat)); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}
