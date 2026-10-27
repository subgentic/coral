package board

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
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
	Session  string // the session the claimer was on at the claim (recorded then, so a restart since does not change it); "" when none was recorded
	Thinking string // the thinking level recorded at the claim; "" when none (every older claim)
	Tokens   int64  // input + output, as stored when the task was completed
	CostUSD  float64
	// ClaimedAt and EndedAt bound the last round of work: its claim, and its submission for review (or completion when it was never submitted); both RFC 3339 UTC, "" when unknown.
	ClaimedAt string
	EndedAt   string
	// WorkSeconds is the time worked: the rounds before the last (kept at each send-back) and EndedAt - ClaimedAt; nil when either is unknown or the end is before the claim.
	WorkSeconds *float64
	SentBack    bool // a review round returned it to its author at least once
	// Windows are the claim and hand-in (or completion) of every round of work, oldest first, the last round's being ClaimedAt and EndedAt; each RFC 3339 UTC. The commits made inside any of them are the task's.
	Windows []WorkWindow
}

// WorkWindow is one round of work on a task.
type WorkWindow struct{ Claimed, Ended string }

// reviewTitleRe is how a reviewer's own task is titled; a task like it is never work, whether or not its workflow reads.
var reviewTitleRe = regexp.MustCompile(`^Review #\d+`)

// EfficiencyTasks lists the tasks completed in [since, until) (RFC 3339 UTC), oldest first. The window is compared as text on a bound without its "Z" (windowBound), which orders a stored time with fractions of a second on the right side of a boundary and uses the completed_at index.
func (s *Store) EfficiencyTasks(ctx context.Context, since, until string) ([]EfficiencyTask, error) {
	rows, err := s.reader().QueryxContext(ctx, `SELECT t.id, t.board_id, t.title, COALESCE(t.assigned_to, ''), COALESCE(t.completed_by, ''), COALESCE(t.claimed_at, ''), t.completed_at,
		COALESCE(t.claim_thinking, ''), COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0), COALESCE(t.cost_usd, 0), COALESCE(w.data, ''), COALESCE(t.session_id, ''), COALESCE(t.work_before_seconds, 0), COALESCE(t.work_windows, '')
		FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ? ORDER BY t.completed_at, t.id`, windowBound(since), windowBound(until))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EfficiencyTask{}
	for rows.Next() {
		var t EfficiencyTask
		var assigned, completedBy, completedAt, data string
		var before float64
		var windows string
		if err := rows.Scan(&t.ID, &t.Board, &t.Title, &assigned, &completedBy, &t.ClaimedAt, &completedAt, &t.Thinking, &t.Tokens, &t.CostUSD, &data, &t.Session, &before, &windows); err != nil {
			return nil, err
		}
		if reviewTitleRe.MatchString(t.Title) {
			continue // a review task, whatever its workflow says
		}
		t.EndedAt = completedAt
		t.Claimer = firstNonEmpty(assigned, completedBy)
		if data != "" {
			w, err := decodeWorkflow(data, true)
			if err != nil {
				slog.Warn("efficiency: a task's workflow could not be read; its review and send-back facts are left out", "board", t.Board, "task", t.ID, "error", err)
			} else {
				if w.ReviewOf > 0 {
					continue // a review task
				}
				if w.OriginalAuthor != "" {
					t.Claimer = w.OriginalAuthor
				}
				if cr := w.CompletionReview; cr != nil && strings.TrimSpace(cr.SubmittedAt) != "" {
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
			v := before + ended.Sub(claimed).Seconds()
			t.WorkSeconds = &v
		}
		var prior [][2]string
		if windows != "" {
			if err := json.Unmarshal([]byte(windows), &prior); err != nil {
				slog.Warn("efficiency: a task's earlier rounds could not be read", "board", t.Board, "task", t.ID, "error", err)
			}
		}
		for _, w := range prior {
			t.Windows = append(t.Windows, WorkWindow{Claimed: w[0], Ended: w[1]})
		}
		if ok1 && ok2 {
			t.Windows = append(t.Windows, WorkWindow{Claimed: t.ClaimedAt, Ended: t.EndedAt})
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

// keepWorkBeforeSQL is the assignment a send-back or a rejection makes before it clears claimed_at: the work of the round that just ended (its claim to its submission for review) is added to what the task
// already had, so the Analytics view's task time counts the first rounds too (#8968). It also keeps the round's claim and hand-in, so the commits of every round count for the task. It takes the submission time four times (keepWorkArgs); a task with no claim or no submission adds nothing.
const keepWorkBeforeSQL = `work_before_seconds = COALESCE(work_before_seconds, 0) + CASE WHEN claimed_at IS NOT NULL AND ? != '' THEN MAX(0, (julianday(?) - julianday(claimed_at)) * 86400) ELSE 0 END,
	work_windows = CASE WHEN claimed_at IS NOT NULL AND ? != '' THEN json_insert(COALESCE(work_windows, '[]'), '$[#]', json_array(claimed_at, ?)) ELSE work_windows END`

// keepWorkArgs are the four arguments of keepWorkBeforeSQL: the submission time, for each of its guards and values.
func keepWorkArgs(submittedAt string) []any {
	return []any{submittedAt, submittedAt, submittedAt, submittedAt}
}

// submittedAtOf is when the task's current candidate was submitted for review, "" when it has none.
func submittedAtOf(cr *CompletionReview) string {
	if cr == nil {
		return ""
	}
	return strings.TrimSpace(cr.SubmittedAt)
}

// windowBound is an RFC 3339 time as the bound of a text comparison with a stored completed_at: without its "Z", so a stored time with fractions of a second ("...00.5Z") sorts after the whole second it falls in
// and before the next, as the instants do.
func windowBound(rfc3339 string) string {
	return strings.TrimSuffix(strings.TrimSpace(rfc3339), "Z")
}
