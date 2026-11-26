package board

import (
	"context"
	"time"
)

// RequeueStaleClaim sends a task in progress back to pending, still its owner's (#21700): its owner is asleep or idle and it has shown no activity since before. It returns false when the task is no
// longer in progress, is parked, or has had activity since (a claim that moved meanwhile is left alone). The claim's session and time are cleared, as a reassign clears them, so the owner claims it afresh.
func (s *Store) RequeueStaleClaim(ctx context.Context, project string, id int64, before time.Time) (bool, error) {
	cut := before.UTC().Format("2006-01-02T15:04:05Z")
	res, err := s.db.ExecContext(ctx,
		`UPDATE board_tasks SET status = 'pending', claimed_at = NULL, session_id = NULL
		 WHERE id = ? AND board_id = ? AND `+holdsSlotSQL+` AND assigned_to IS NOT NULL AND assigned_to != ''
		   AND COALESCE(last_activity_at, claimed_at, created_at) <= ?`, id, project, cut)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
