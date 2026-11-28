package board

import (
	"context"
	"database/sql"
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

// PruneGoalEventsBatch keeps the newest keep events of each board and deletes at most batch of the rest, and says how many it deleted. Each board's cut is found from its own (board_id, id) index, so no pass reads the
// whole table, and each delete is one short statement: the board database has one writer, and a caller that wants everything gone calls it again with a pause between (#22013). Keeping none is refused: the feed's
// window would always say it missed some.
func (s *Store) PruneGoalEventsBatch(ctx context.Context, keep, batch int) (int64, error) {
	if keep < 1 {
		return 0, errors.New("goal events: keep at least one per board")
	}
	if batch < 1 {
		return 0, errors.New("goal events: batch at least one")
	}
	var boards []string
	if err := s.reader().SelectContext(ctx, &boards, `SELECT DISTINCT board_id FROM board_goal_events`); err != nil {
		return 0, err
	}
	var total int64
	for _, b := range boards {
		if total >= int64(batch) || ctx.Err() != nil {
			break
		}
		var cut int64 // the newest event that is past the window: it and every older one go
		err := s.reader().GetContext(ctx, &cut, `SELECT id FROM board_goal_events WHERE board_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`, b, keep)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return total, err
		}
		res, err := s.db.ExecContext(ctx, `DELETE FROM board_goal_events WHERE id IN (
			SELECT id FROM board_goal_events WHERE board_id = ? AND id <= ? ORDER BY id LIMIT ?)`, b, cut, int64(batch)-total)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
	}
	return total, ctx.Err()
}

// PruneGoalEvents keeps the newest keep events of each board and deletes every other, in batches with no pause (a test or a one-off; the job pauses between batches).
func (s *Store) PruneGoalEvents(ctx context.Context, keep int) (int64, error) {
	const batch = 5000
	var total int64
	for {
		n, err := s.PruneGoalEventsBatch(ctx, keep, batch)
		total += n
		if err != nil || n < batch {
			return total, err
		}
	}
}

// CheckpointPassive copies the board database's WAL into its file without waiting on readers or writers: a prune calls it after each batch so no one write copies and syncs megabytes of WAL (#22119).
func (s *Store) CheckpointPassive(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(PASSIVE)`)
	return err
}
