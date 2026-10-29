package board

import (
	"context"
	"regexp"
	"strings"
)

// BoardKindJob marks a board a scheduled job's (or workflow step's) agent used. No search level reads such a board (#11076): the live row that said a session was a job is gone once the run ends, so the board itself
// carries the mark.
const BoardKindJob = "job"

// MarkBoardKind sets a board's kind (once: a board already of that kind is left alone) and reports whether it changed.
func (s *Store) MarkBoardKind(ctx context.Context, key, kind string) (bool, error) {
	if key == "" || kind == "" {
		return false, nil
	}
	res, err := s.db.ExecContext(ctx, `UPDATE boards SET kind = ? WHERE id = ? AND kind != ?`, kind, key, kind)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// BoardKeysOfKind are the keys of the boards marked with kind.
func (s *Store) BoardKeysOfKind(ctx context.Context, kind string) ([]string, error) {
	var keys []string
	err := s.reader().SelectContext(ctx, &keys, `SELECT id FROM boards WHERE kind = ?`, kind)
	return keys, err
}

var sessionIDShape = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)

// MarkJobBoardsOfSessions marks every board one of these sessions was ever a member of (a member's name is "<type>-<session id>"), for the boards a job used before they were marked at the source. It returns how
// many boards it marked.
func (s *Store) MarkJobBoardsOfSessions(ctx context.Context, sessionIDs []string) (int, error) {
	want := map[string]bool{}
	for _, id := range sessionIDs {
		if sessionIDShape.MatchString(id) {
			want[strings.ToLower(id)] = true
		}
	}
	if len(want) == 0 {
		return 0, nil
	}
	var rows []struct {
		Project     string `db:"project"`
		SessionName string `db:"session_name"`
	}
	if err := s.db.SelectContext(ctx, &rows, `SELECT DISTINCT project, session_name FROM board_subscribers WHERE session_name IS NOT NULL AND session_name != ''`); err != nil {
		return 0, err
	}
	marked := 0
	done := map[string]bool{}
	for _, r := range rows {
		i := strings.Index(r.SessionName, "-")
		if i < 0 || done[r.Project] || !want[strings.ToLower(r.SessionName[i+1:])] {
			continue
		}
		done[r.Project] = true
		if changed, err := s.MarkBoardKind(ctx, r.Project, BoardKindJob); err != nil {
			return marked, err
		} else if changed {
			marked++
		}
	}
	return marked, nil
}

// BackfillJobBoards marks the boards the sessions of past and present job runs were members of: every session a scheduled run recorded and every live job row, read from the sessions database. It is what can be
// recovered; a board a job used through a member name that no longer names its session, or whose subscriber rows were deleted, cannot be told from a team's and stays unmarked.
func (s *Store) BackfillJobBoards(ctx context.Context) (int, error) {
	if s.sessionsDB == nil {
		return 0, nil
	}
	var ids []string
	if err := s.sessionsDB.SelectContext(ctx, &ids,
		`SELECT session_id FROM scheduled_runs WHERE session_id IS NOT NULL AND session_id != '' UNION SELECT session_id FROM live_sessions WHERE is_job = 1`); err != nil {
		return 0, err
	}
	return s.MarkJobBoardsOfSessions(ctx, ids)
}
