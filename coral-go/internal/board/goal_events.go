package board

import (
	"context"
	"errors"

	"github.com/jmoiron/sqlx"
)

// GoalEvent is what a goal change was, as the feed names it (#7355): the board, the goal, a kind and the board's goals counter (seq) the change gave. Ids and a kind only: no text, so what may see a
// goals brief may see these. Kinds: goal_created, goal_updated, goal_closed, goal_reopened, goal_deleted, task_linked, task_unlinked, task_state.
type GoalEvent struct {
	Board string `db:"board_id" json:"board"`
	Goal  int64  `db:"goal_id" json:"goal"`
	Kind  string `db:"kind" json:"kind"`
	Seq   int64  `db:"seq" json:"seq"`
}

// GoalEventsWindow is the newest n goal events of each of the boards, oldest first (one query, ids and kinds). A board with none is not in the map. The triggers write them (ensureGoalsSchema), and
// PruneGoalEvents removes the old: a reader that wants the events since a counter value takes them from this window and, when the window does not reach back to it, knows it missed some.
func (s *Store) GoalEventsWindow(ctx context.Context, boards []string, n int) (map[string][]GoalEvent, error) {
	out := map[string][]GoalEvent{}
	if len(boards) == 0 || n <= 0 {
		return out, nil
	}
	q, args, err := sqlx.In(`SELECT board_id, goal_id, kind, seq FROM (
			SELECT board_id, goal_id, kind, seq, id, ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY id DESC) AS rn FROM board_goal_events WHERE board_id IN (?)
		) WHERE rn <= ? ORDER BY board_id, id`, boards, n)
	if err != nil {
		return nil, err
	}
	var rows []GoalEvent
	if err := s.reader().SelectContext(ctx, &rows, q, args...); err != nil {
		return nil, err
	}
	for _, e := range rows {
		out[e.Board] = append(out[e.Board], e)
	}
	return out, nil
}

// PruneGoalEvents keeps the newest keep events of each board and deletes the rest, and says how many it deleted (the periodic job's work). Keeping none is refused: the feed's window would always say it missed some.
func (s *Store) PruneGoalEvents(ctx context.Context, keep int) (int64, error) {
	if keep < 1 {
		return 0, errors.New("goal events: keep at least one per board")
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM board_goal_events WHERE id IN (
		SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY id DESC) AS rn FROM board_goal_events) WHERE rn > ?)`, keep)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
