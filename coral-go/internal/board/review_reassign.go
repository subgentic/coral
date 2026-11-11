package board

import (
	"context"
	"fmt"
	"strings"
)

// reassignReviewTask moves one reviewer's review task to another reviewer (#14866, the Operator). The review task keeps its id and its place in the parent's open round: the round names the new
// reviewer where the old one was, and the verdicts the other reviewers gave stay. It refuses the parent's author, a reviewer who is already on the round, the same reviewer, someone not on the
// board, a review that is finished and a parent that is no longer in review (each a typed refusal the route answers 409 with the reason).
func (s *Store) reassignReviewTask(ctx context.Context, project string, reviewTaskID, parentID int64, to string) (*Task, error) {
	refuse := func(format string, a ...any) error {
		return fmt.Errorf("%w: %s", ErrTaskReassignRefused, fmt.Sprintf(format, a...))
	}
	to = strings.TrimSpace(to)
	if to == "" {
		return nil, refuse("name the reviewer who takes review task #%d: coral-board task reassign %d --to \"Name\"", reviewTaskID, reviewTaskID)
	}
	task, err := s.getTaskByID(ctx, project, reviewTaskID)
	if err != nil || task == nil {
		return nil, fmt.Errorf("task #%d is not on this board", reviewTaskID)
	}
	if task.Status != "pending" && task.Status != "in_progress" && task.Status != "blocked" {
		return nil, refuse("review task #%d is %s: a finished review is not moved", reviewTaskID, task.Status)
	}
	parent, err := s.getTaskByID(ctx, project, parentID)
	if err != nil || parent == nil || parent.Status != "review_pending" {
		return nil, refuse("task #%d is no longer in review: there is no open round to move this review in", parentID)
	}
	w, err := loadWorkflow(ctx, s.db, parentID)
	if err != nil {
		return nil, err
	}
	if len(w.ReviewRounds) == 0 || w.ReviewRounds[len(w.ReviewRounds)-1].Result != "" {
		return nil, refuse("task #%d has no open review round", parentID)
	}
	round := &w.ReviewRounds[len(w.ReviewRounds)-1]
	at := -1
	for i, r := range round.Reviewers {
		if strings.EqualFold(r.Reviewer, to) {
			return nil, refuse("%s is already reviewing #%d", r.Reviewer, parentID)
		}
		if r.ReviewTaskID == reviewTaskID {
			at = i
		}
	}
	if at < 0 || round.Reviewers[at].State != "pending" {
		return nil, refuse("review task #%d is not an open review of the current round", reviewTaskID)
	}
	if strings.EqualFold(to, w.OriginalAuthor) {
		return nil, refuse("%s did the work and can't review it", to)
	}
	sub, err := s.GetProjectSubscription(ctx, project, to)
	if err != nil {
		return nil, err
	}
	if sub == nil || sub.IsActive == 0 {
		return nil, refuse("%s is not on this board", to)
	}
	round.Reviewers[at].Reviewer = to
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE board_tasks SET assigned_to = ?, status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'pending' END, claimed_at = NULL, session_id = NULL WHERE id = ? AND board_id = ?`, to, reviewTaskID, project); err != nil {
		return nil, err
	}
	if err := saveWorkflow(ctx, tx, parentID, w); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.getTaskByID(ctx, project, reviewTaskID)
}
