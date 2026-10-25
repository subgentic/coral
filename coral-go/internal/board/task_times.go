package board

import (
	"context"
	"sort"
	"strings"
	"time"
)

// Task times for the Analytics view (#7525), from what the board already stores: created_at, claimed_at and completed_at of a task, and the review rounds of its workflow. Nothing here adds a field. The one
// thing the store does not keep is when a task was SUBMITTED for review (the orchestrator receives it and delegates later), so review time is "from assignment to approval": the first review round's
// delegated_at to the last round's concluded_at.

// TaskTime is one completed task's times.
type TaskTime struct {
	ID             int64
	CompletedBy    string
	CreatedAt      string
	ClaimedAt      string
	CompletedAt    string
	Rounds         int    // review rounds the task had
	RejectedRounds int    // of those, the ones that went back to the author
	ReviewFrom     string // the first round's delegated_at
	ReviewTo       string // the last approved round's concluded_at
}

// TasksCompletedBetween lists a board's tasks completed in [since, until) (RFC 3339 UTC), oldest first. Skipped and cancelled tasks are not completed work and are left out.
func (s *Store) TasksCompletedBetween(ctx context.Context, project, since, until string) ([]TaskTime, error) {
	rows, err := s.reader().QueryxContext(ctx, `SELECT t.id, COALESCE(t.completed_by, ''), t.created_at, COALESCE(t.claimed_at, ''), t.completed_at, COALESCE(w.data, '')
		FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ? ORDER BY t.completed_at, t.id`, project, since, until)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TaskTime{}
	for rows.Next() {
		var tt TaskTime
		var data string
		if err := rows.Scan(&tt.ID, &tt.CompletedBy, &tt.CreatedAt, &tt.ClaimedAt, &tt.CompletedAt, &data); err != nil {
			return nil, err
		}
		if data != "" && strings.Contains(data, `"review_rounds"`) {
			if w, err := decodeWorkflow(data, true); err == nil && len(w.ReviewRounds) > 0 {
				tt.Rounds = len(w.ReviewRounds)
				for _, r := range w.ReviewRounds {
					if r.Result == "rejected" {
						tt.RejectedRounds++
					}
				}
				tt.ReviewFrom = w.ReviewRounds[0].DelegatedAt
				if last := w.ReviewRounds[len(w.ReviewRounds)-1]; last.Result == "approved" {
					tt.ReviewTo = last.ConcludedAt
				}
			}
		}
		out = append(out, tt)
	}
	return out, rows.Err()
}

// TaskTimeStats summarises completed tasks. A duration is seconds; a field that no task could answer is nil (never zero): a number of tasks with a claim time, a review, and so on.
type TaskTimeStats struct {
	Done          int      `json:"done"`
	WorkMedian    *float64 `json:"median_s,omitempty"` // claimed to completed
	WorkP90       *float64 `json:"p90_s,omitempty"`
	WaitMedian    *float64 `json:"wait_median_s,omitempty"`   // created to claimed
	ReviewMedian  *float64 `json:"review_median_s,omitempty"` // review assigned (round 1 delegated) to approval; the submit time itself is not stored
	RoundsMean    *float64 `json:"rounds_mean,omitempty"`
	WentBack2Plus int      `json:"sent_back"` // tasks sent back to their author twice or more
}

// SummarizeTaskTimes computes the stats of tt.
func SummarizeTaskTimes(tt []TaskTime) TaskTimeStats {
	st := TaskTimeStats{Done: len(tt)}
	var work, wait, review []float64
	var rounds, withRounds float64
	for _, t := range tt {
		created, c1 := parseT(t.CreatedAt)
		claimed, c2 := parseT(t.ClaimedAt)
		done, c3 := parseT(t.CompletedAt)
		if c2 && c3 && !done.Before(claimed) {
			work = append(work, done.Sub(claimed).Seconds())
		}
		if c1 && c2 && !claimed.Before(created) {
			wait = append(wait, claimed.Sub(created).Seconds())
		}
		if from, ok1 := parseT(t.ReviewFrom); ok1 {
			if to, ok2 := parseT(t.ReviewTo); ok2 && !to.Before(from) {
				review = append(review, to.Sub(from).Seconds())
			}
		}
		if t.Rounds > 0 {
			rounds += float64(t.Rounds)
			withRounds++
		}
		if t.RejectedRounds >= 2 {
			st.WentBack2Plus++
		}
	}
	st.WorkMedian, st.WorkP90 = percentile(work, 50), percentile(work, 90)
	st.WaitMedian, st.ReviewMedian = percentile(wait, 50), percentile(review, 50)
	if withRounds > 0 {
		m := rounds / withRounds
		st.RoundsMean = &m
	}
	return st
}

func parseT(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	return t, err == nil
}

// percentile is the p-th percentile (nearest rank) of xs, nil for no values.
func percentile(xs []float64, p int) *float64 {
	if len(xs) == 0 {
		return nil
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	rank := (p*len(s) + 99) / 100 // ceil(p/100 * n)
	if rank < 1 {
		rank = 1
	}
	v := s[rank-1]
	return &v
}
