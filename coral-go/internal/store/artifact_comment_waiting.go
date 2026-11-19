package store

import (
	"context"
	"sort"
	"strconv"
	"time"
)

// WaitingComment is a comment of the Operator's that was put to one agent (the comment's ask) and that the agent has not answered (#19916): no reply of an agent in the comment's thread since the ask, and the ask not ended.
type WaitingComment struct {
	CommentID    int64
	RootID       int64 // the thread: the comment itself, or the comment it replies to
	ArtifactID   string
	Board        string
	AgentSession string
	AgentName    string
	Body         string // the Operator's words
	Since        time.Time
}

// WaitingComments lists the Operator's comments sent to an agent in the last maxAge that the agent has not replied to, oldest first, one per thread and agent (the newest comment). An ask that ended (resolved, deleted,
// answered by a new version of the file, or undeliverable) is not listed. The times are compared here, as times: the comments' created_at is RFC 3339 text of varying length, which SQL must not order or compare.
func (s *SessionStore) WaitingComments(ctx context.Context, now time.Time, maxAge time.Duration) ([]WaitingComment, error) {
	var rows []struct {
		AskID        int64  `db:"ask_id"`
		CommentID    int64  `db:"comment_id"`
		RootID       int64  `db:"root_id"`
		ArtifactID   string `db:"artifact_id"`
		Board        string `db:"board"`
		AgentSession string `db:"agent_session"`
		AgentName    string `db:"agent_name"`
		AskedAt      string `db:"created_at"`
		Body         string `db:"body"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `
		SELECT a.id AS ask_id, a.comment_id AS comment_id, COALESCE(c.parent_id, c.id) AS root_id, a.artifact_id AS artifact_id, a.board AS board, a.agent_session AS agent_session,
		       a.agent_name AS agent_name, a.created_at AS created_at, c.body AS body
		FROM artifact_comment_asks a JOIN artifact_comments c ON c.id = a.comment_id
		WHERE a.closed_at IS NULL AND c.deleted_at IS NULL AND c.resolved_at IS NULL AND c.author_kind = 'owner' AND a.created_at > ?
		ORDER BY a.id`, now.Add(-maxAge).UTC().Format(ISOFormat)); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	var replies []struct {
		ParentID  int64  `db:"parent_id"`
		CreatedAt string `db:"created_at"`
	}
	if err := s.reader().SelectContext(ctx, &replies, `SELECT parent_id, created_at FROM artifact_comments WHERE author_kind = 'agent' AND deleted_at IS NULL AND parent_id IS NOT NULL`); err != nil {
		return nil, err
	}
	lastReply := map[int64]time.Time{} // thread root -> newest agent reply
	for _, r := range replies {
		if at, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err == nil && at.After(lastReply[r.ParentID]) {
			lastReply[r.ParentID] = at
		}
	}
	newest := map[string]int{} // thread + agent -> index in out
	var out []WaitingComment
	for _, r := range rows {
		since, err := time.Parse(ISOFormat, r.AskedAt)
		if err != nil {
			continue
		}
		if lastReply[r.RootID].After(since) { // the agent replied in the thread after the ask
			continue
		}
		w := WaitingComment{CommentID: r.CommentID, RootID: r.RootID, ArtifactID: r.ArtifactID, Board: r.Board, AgentSession: r.AgentSession, AgentName: r.AgentName, Body: r.Body, Since: since}
		key := r.ArtifactID + "\x00" + r.AgentSession + "\x00" + strconv.FormatInt(r.RootID, 10)
		if i, ok := newest[key]; ok {
			out[i] = w
			continue
		}
		newest[key] = len(out)
		out = append(out, w)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Since.Before(out[j].Since) })
	return out, nil
}
