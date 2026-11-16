package board

import (
	"context"
	"fmt"
)

// The reviewer pool (#17612): reviews spread themselves. A team lists a group to "pick one from"; a task entering review goes to the group member with the fewest open review tasks, ties to the one
// given a review longest ago, never the author, anyone whose session a person put to sleep, anyone not on the board, or anyone already named on this round.

// InReviewerPool reports whether name is in the board's reviewer pool.
func (s *Store) InReviewerPool(ctx context.Context, project, name string) bool {
	for _, p := range s.GetHealthSettings(ctx, project).ReviewerPool {
		if SameIdentity(p, name) {
			return true
		}
	}
	return false
}

// pickFromReviewerPool picks one reviewer of pool and says why ("least open reviews: 2"); "" when nobody qualifies.
func (s *Store) pickFromReviewerPool(ctx context.Context, project string, pool, skip []string, subs []Subscriber) (string, string) {
	asleep, _ := s.SleepingSubscribers(ctx, project)
	open, _ := s.OpenReviews(ctx, project)
	var last []struct {
		Assignee string `db:"assigned_to"`
		At       string `db:"at"`
	}
	_ = s.reader().SelectContext(ctx, &last, `SELECT t.assigned_to, MAX(t.created_at) AS at FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.assigned_to IS NOT NULL AND COALESCE(json_extract(w.data, '$.review_of'), 0) > 0 GROUP BY t.assigned_to`, project)
	given := map[string]string{}
	for _, l := range last {
		given[l.Assignee] = l.At
	}
	best, bestOpen, bestAt := "", 0, ""
	for _, c := range pool {
		id := ""
		for _, sub := range subs {
			if SameIdentity(c, sub.SubscriberID) {
				id = sub.SubscriberID
				break
			}
		}
		if id == "" || asleep[id] {
			continue
		}
		skipped := false
		for _, e := range skip {
			if e != "" && SameIdentity(id, e) {
				skipped = true
				break
			}
		}
		if skipped {
			continue
		}
		n, at := len(open[id]), given[id]
		if best == "" || n < bestOpen || (n == bestOpen && at < bestAt) {
			best, bestOpen, bestAt = id, n, at
		}
	}
	if best == "" {
		return "", ""
	}
	return best, fmt.Sprintf("least open reviews: %d", bestOpen)
}
