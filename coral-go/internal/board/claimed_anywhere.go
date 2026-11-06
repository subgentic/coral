package board

import (
	"context"
	"strings"
)

// ClaimedTaskAnywhere is the most important task member has claimed and is working on (in progress) on ANY board, with the board it is on and its priority (critical, high, medium or low): what the resource
// queue (pkg/resourcequeue, #13613) ranks an agent's claim by. ok is false when the member has no task in progress. The most important wins; the most recently claimed breaks a tie (a forgotten old task must not outrank today's work).
func (s *Store) ClaimedTaskAnywhere(ctx context.Context, member string) (taskID int64, project, priority string, ok bool, err error) {
	return s.claimedTask(ctx, member, nil)
}

// ClaimedTaskOnBoards is ClaimedTaskAnywhere limited to the given boards (#13833: two agents of two boards can share a name, and a claim must not show the other's task).
func (s *Store) ClaimedTaskOnBoards(ctx context.Context, member string, boards []string) (taskID int64, project, priority string, ok bool, err error) {
	if len(boards) == 0 {
		return 0, "", "", false, nil
	}
	return s.claimedTask(ctx, member, boards)
}

// BoardsOfSession is the boards an agent session (by its name) is an active member of.
func (s *Store) BoardsOfSession(ctx context.Context, sessionName string) ([]string, error) {
	var out []string
	if sessionName == "" {
		return nil, nil
	}
	err := s.reader().SelectContext(ctx, &out, `SELECT DISTINCT project FROM board_subscribers WHERE session_name = ? AND is_active = 1`, sessionName)
	return out, err
}

func (s *Store) claimedTask(ctx context.Context, member string, boards []string) (taskID int64, project, priority string, ok bool, err error) {
	var rows []struct {
		ID       int64  `db:"id"`
		BoardID  string `db:"board_id"`
		Priority string `db:"priority"`
	}
	where, args := "", []any{member}
	if boards != nil {
		marks := make([]string, len(boards))
		for i, b := range boards {
			marks[i] = "?"
			args = append(args, b)
		}
		where = " AND board_id IN (" + strings.Join(marks, ",") + ")"
	}
	if err = s.reader().SelectContext(ctx, &rows, `SELECT id, board_id, priority FROM board_tasks WHERE assigned_to = ? COLLATE NOCASE AND status = 'in_progress'`+where+`
		ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, COALESCE(claimed_at, created_at) DESC, id DESC LIMIT 1`, args...); err != nil {
		return 0, "", "", false, err
	}
	if len(rows) == 0 {
		return 0, "", "", false, nil
	}
	return rows[0].ID, rows[0].BoardID, rows[0].Priority, true, nil
}

// SessionIsRegisteredOrchestrator reports whether the agent session is an active member whose LAUNCH RECORD says it is an Orchestrator (can_peek). Never by name or job title: a join takes the title from the
// caller, and a team with no Orchestrator lets the first one that claims the title stand, so a title is not a privilege (Security, #13613; compare RequireTaskReviewer). The join route never sets can_peek.
func (s *Store) SessionIsRegisteredOrchestrator(ctx context.Context, session string) (bool, error) {
	if session == "" {
		return false, nil
	}
	sub, err := s.GetSubscriptionBySessionName(ctx, session)
	if err != nil || sub == nil {
		return false, err
	}
	return sub.IsActive != 0 && sub.CanPeek != 0, nil
}
