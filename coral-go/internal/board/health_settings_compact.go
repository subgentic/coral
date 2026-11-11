package board

import (
	"context"
	"time"
)

// FinishedTaskAt is when subscriberID last finished a task on project: completed it, or submitted it for review (#14849, the after-task trigger of the context compaction). False when it has not.
func (s *Store) FinishedTaskAt(ctx context.Context, project, subscriberID string) (time.Time, bool) {
	m := s.FinishedTasksAt(ctx, project, []string{subscriberID})
	at, ok := m[subscriberID]
	return at, ok
}

// FinishedTasksAt is FinishedTaskAt for several members from one read of the team's tasks (#15066): the compaction asked once per candidate every minute, and each ask loaded every task of the board. A member that
// has not finished a task is not in the map; a read that fails gives an empty one.
func (s *Store) FinishedTasksAt(ctx context.Context, project string, subscriberIDs []string) map[string]time.Time {
	out := map[string]time.Time{}
	tasks, err := s.ListTasks(ctx, project)
	if err != nil {
		return out
	}
	for _, id := range subscriberIDs {
		var last time.Time
		note := func(at string) {
			if t, err := time.Parse(time.RFC3339, at); err == nil && t.After(last) {
				last = t
			}
		}
		for _, t := range tasks {
			if t.CompletedBy != nil && t.CompletedAt != nil && SameIdentity(*t.CompletedBy, id) {
				note(*t.CompletedAt)
			}
			if cr := t.Workflow.CompletionReview; cr != nil && SameIdentity(cr.SubmittedBy, id) {
				note(cr.SubmittedAt)
			}
		}
		if !last.IsZero() {
			out[id] = last
		}
	}
	return out
}
