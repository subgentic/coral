package board

import (
	"context"
	"strings"
)

// The finished tasks of every board, as the Analytics view's efficiency measures read them (#8915): who did the work, how long it took with review left out, whether it was sent back, and the tokens and cost
// the board stored for it. Review tasks (the reviewers' own tasks, "Review #N") are left out: they are not work on the team's product.

// EfficiencyTask is one completed task.
type EfficiencyTask struct {
	ID       int64
	Board    string
	Title    string
	Claimer  string // the agent that did the work: the task's original author after a review, else who it was assigned to, else who completed it
	Thinking string // the thinking level recorded at the claim; "" when none (every older claim)
	Tokens   int64  // input + output, as stored when the task was completed
	CostUSD  float64
	// ClaimedAt and EndedAt bound the work: the (last) claim, and the last submission for review (or completion when it was never submitted); both RFC 3339 UTC, "" when unknown.
	ClaimedAt string
	EndedAt   string
	// WorkSeconds is EndedAt - ClaimedAt; nil when either is unknown or the end is before the claim.
	WorkSeconds *float64
	SentBack    bool // a review round returned it to its author at least once
}

// EfficiencyTasks lists the tasks completed in [since, until) (RFC 3339 UTC), oldest first.
func (s *Store) EfficiencyTasks(ctx context.Context, since, until string) ([]EfficiencyTask, error) {
	rows, err := s.reader().QueryxContext(ctx, `SELECT t.id, t.board_id, t.title, COALESCE(t.assigned_to, ''), COALESCE(t.completed_by, ''), COALESCE(t.claimed_at, ''), t.completed_at,
		COALESCE(t.claim_thinking, ''), COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0), COALESCE(t.cost_usd, 0), COALESCE(w.data, '')
		FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ? ORDER BY t.completed_at, t.id`, since, until)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EfficiencyTask{}
	for rows.Next() {
		var t EfficiencyTask
		var assigned, completedBy, completedAt, data string
		if err := rows.Scan(&t.ID, &t.Board, &t.Title, &assigned, &completedBy, &t.ClaimedAt, &completedAt, &t.Thinking, &t.Tokens, &t.CostUSD, &data); err != nil {
			return nil, err
		}
		t.EndedAt = completedAt
		t.Claimer = firstNonEmpty(assigned, completedBy)
		if data != "" {
			if w, err := decodeWorkflow(data, true); err == nil {
				if w.ReviewOf > 0 {
					continue // a review task
				}
				if w.OriginalAuthor != "" {
					t.Claimer = w.OriginalAuthor
				}
				if cr := w.CompletionReview; cr != nil && strings.TrimSpace(cr.SubmittedAt) != "" && len(w.ReviewRounds) > 0 {
					t.EndedAt = cr.SubmittedAt // review time is not work time: the work ended when it was handed in
				}
				for _, r := range w.ReviewRounds {
					if r.Result == "rejected" {
						t.SentBack = true
					}
				}
			}
		}
		claimed, ok1 := parseT(t.ClaimedAt)
		ended, ok2 := parseT(t.EndedAt)
		if ok1 && ok2 && !ended.Before(claimed) {
			v := ended.Sub(claimed).Seconds()
			t.WorkSeconds = &v
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// SubscriberSessions maps "board|subscriber" to the session name the subscriber is on now ("agentType-sessionID"), for every board: it says which session did a task's work.
func (s *Store) SubscriberSessions(ctx context.Context) (map[string]string, error) {
	var rows []struct {
		Project string `db:"project"`
		ID      string `db:"subscriber_id"`
		Session string `db:"session_name"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT project, subscriber_id, session_name FROM board_subscribers WHERE session_name != ''`); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Project+"|"+r.ID] = r.Session
	}
	return out, nil
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
