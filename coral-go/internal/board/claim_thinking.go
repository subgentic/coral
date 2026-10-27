package board

import (
	"context"

	"github.com/subgentic/coral/internal/thinkinglevel"
)

// SetClaimThinking records the thinking level the agent that just claimed a task was set to (#8915): trimmed, lower-cased and capped to the known levels (anything else is "other"), and nothing at all for "" (never a guess). It is written for a task in
// progress only, so a late call cannot mark a task someone else has finished. Best effort for the caller: a claim without it is just not recorded, as every claim before it.
func (s *Store) SetClaimThinking(ctx context.Context, project string, taskID int64, thinking string) error {
	level := thinkinglevel.Normalize(thinking)
	if level == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET claim_thinking = ? WHERE id = ? AND board_id = ? AND status = 'in_progress'`, level, taskID, project)
	return err
}

// ClaimThinking is the thinking level recorded for a task's claim, "" when none was (every claim before #8915, an agent with no level).
func (s *Store) ClaimThinking(ctx context.Context, project string, taskID int64) (string, error) {
	var level *string
	if err := s.reader().GetContext(ctx, &level, `SELECT claim_thinking FROM board_tasks WHERE id = ? AND board_id = ?`, taskID, project); err != nil {
		return "", err
	}
	if level == nil {
		return "", nil
	}
	return *level, nil
}
