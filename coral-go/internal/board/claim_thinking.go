package board

import (
	"context"
	"strings"
)

// SetClaimThinking records the thinking level the agent that just claimed a task was set to (#8915): trimmed and lower-cased, and nothing at all for "" (never a guess). It is written for a task in
// progress only, so a late call cannot mark a task someone else has finished. Best effort for the caller: a claim without it is just not recorded, as every claim before it.
func (s *Store) SetClaimThinking(ctx context.Context, project string, taskID int64, thinking string) error {
	level := strings.ToLower(strings.TrimSpace(thinking))
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
