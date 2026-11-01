package board

import (
	"context"
	"errors"
)

// MarkGoalOrchestratorTold records that the Orchestrator is being told about goal id of the board, and says whether this call is the one that did: the time is set once and never moves, so two writers
// racing to announce a goal tell the Orchestrator once (#11866). It does not touch updated_at or the goal's change counter: it is not a change of the goal.
func (s *Store) MarkGoalOrchestratorTold(ctx context.Context, board string, id int64) (told bool, at string, err error) {
	if board == "" || id <= 0 {
		return false, "", errors.New("a goal needs a board and an id")
	}
	at = nowUTC()
	res, err := s.db.ExecContext(ctx, `UPDATE board_goals SET orchestrator_told_at = ? WHERE id = ? AND board_id = ? AND orchestrator_told_at IS NULL`, at, id, board)
	if err != nil {
		return false, "", err
	}
	n, err := res.RowsAffected()
	if err != nil || n == 0 {
		return false, "", err
	}
	return true, at, nil
}
