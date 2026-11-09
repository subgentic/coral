package board

import (
	"context"
	"time"
)

// FinishedTaskAt is when subscriberID last finished a task on project: completed it, or submitted it for review (#14849, the after-task trigger of the context compaction). False when it has not.
func (s *Store) FinishedTaskAt(ctx context.Context, project, subscriberID string) (time.Time, bool) {
	tasks, err := s.ListTasks(ctx, project)
	if err != nil {
		return time.Time{}, false
	}
	var last time.Time
	note := func(at string) {
		if t, err := time.Parse(time.RFC3339, at); err == nil && t.After(last) {
			last = t
		}
	}
	for _, t := range tasks {
		if t.CompletedBy != nil && t.CompletedAt != nil && SameIdentity(*t.CompletedBy, subscriberID) {
			note(*t.CompletedAt)
		}
		if cr := t.Workflow.CompletionReview; cr != nil && SameIdentity(cr.SubmittedBy, subscriberID) {
			note(cr.SubmittedAt)
		}
	}
	return last, !last.IsZero()
}
