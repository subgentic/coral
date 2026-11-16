package board

import (
	"context"
	"fmt"
	"log/slog"
	"time"
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
	given := map[string]time.Time{}
	for _, l := range last {
		at := parseStamp(l.At)
		if at.IsZero() {
			// The stamp ranks this member as given a review longest ago; say so instead of doing it silently (#17807).
			slog.Warn("[reviewer pool] a review task's created_at cannot be read; the member ranks as given a review longest ago", "member", l.Assignee, "created_at", l.At)
		}
		given[l.Assignee] = at
	}
	best, bestOpen, bestAt := "", 0, time.Time{}
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
		if best == "" || n < bestOpen || (n == bestOpen && at.Before(bestAt)) {
			best, bestOpen, bestAt = id, n, at
		}
	}
	if best == "" {
		return "", ""
	}
	return best, fmt.Sprintf("least open reviews: %d", bestOpen)
}

// parseStamp reads a stored created_at as a time (RFC 3339 or SQLite's "2006-01-02 15:04:05", with or without fractions); a stamp that is neither is the zero time, which sorts first: given longest ago (#17749, as a string "9" sorted after "10").
func parseStamp(v string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999", "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t
		}
	}
	return time.Time{}
}
