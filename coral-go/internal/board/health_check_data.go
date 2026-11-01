package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
)

// What the orchestrator's check reads from the board (#4175 step 2).

// HealthProgress is what moved on a board since a time: tasks completed (reviews not counted),
// reviews done, and agents' posts (not Coral's own lines).
type HealthProgress struct {
	Completed int `db:"completed"`
	Reviewed  int `db:"reviewed"`
	Posts     int `db:"posts"`
}

// ProgressSince counts what moved on project since since.
func (s *Store) ProgressSince(ctx context.Context, project string, since time.Time) (HealthProgress, error) {
	var p HealthProgress
	at := since.UTC().Format(time.RFC3339)
	err := s.reader().GetContext(ctx, &p, `SELECT
		(SELECT COUNT(*) FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id
		 WHERE t.board_id = ? AND t.status = 'completed' AND t.completed_at > ? AND COALESCE(json_extract(w.data, '$.review_of'), 0) = 0) AS completed,
		(SELECT COUNT(*) FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		 WHERE t.board_id = ? AND t.status = 'completed' AND t.completed_at > ? AND COALESCE(json_extract(w.data, '$.review_of'), 0) > 0) AS reviewed,
		(SELECT COUNT(*) FROM board_messages
		 WHERE project = ? AND created_at > ? AND COALESCE(is_system, 0) = 0) AS posts`,
		project, at, project, at, project, at)
	return p, err
}

// OpenReviews returns, per reviewer, the ids of their open review tasks (pending or in
// progress), oldest first.
func (s *Store) OpenReviews(ctx context.Context, project string) (map[string][]int64, error) {
	var rows []struct {
		ID       int64  `db:"id"`
		Assignee string `db:"assigned_to"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT t.id, t.assigned_to FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.status IN ('pending', 'in_progress') AND t.assigned_to IS NOT NULL
		  AND COALESCE(json_extract(w.data, '$.review_of'), 0) > 0 ORDER BY t.id`, project); err != nil {
		return nil, err
	}
	out := map[string][]int64{}
	for _, r := range rows {
		out[r.Assignee] = append(out[r.Assignee], r.ID)
	}
	return out, nil
}

// Reviewers returns who has done or been given a review on project: the team's reviewers.
func (s *Store) Reviewers(ctx context.Context, project string) (map[string]bool, error) {
	var names []string
	if err := s.reader().SelectContext(ctx, &names, `SELECT DISTINCT t.assigned_to FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.assigned_to IS NOT NULL AND COALESCE(json_extract(w.data, '$.review_of'), 0) > 0`, project); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, n := range names {
		out[n] = true
	}
	return out, nil
}

// TaskSnoozedUntil is the end of a task's reminder snooze, zero when none.
func (s *Store) TaskSnoozedUntil(ctx context.Context, project string, id int64) (time.Time, error) {
	var v sql.NullString
	if err := s.reader().GetContext(ctx, &v, `SELECT idle_snoozed_until FROM board_tasks WHERE id = ? AND board_id = ?`, id, project); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return time.Time{}, nil
		}
		return time.Time{}, err
	}
	if !v.Valid {
		return time.Time{}, nil
	}
	t, _ := time.Parse(time.RFC3339, v.String)
	return t, nil
}

// LastPostBy is a member's latest board post on project (its content and time), "" when none.
func (s *Store) LastPostBy(ctx context.Context, project, subscriberID string) (string, time.Time, error) {
	var row struct {
		Content   string `db:"content"`
		CreatedAt string `db:"created_at"`
	}
	err := s.reader().GetContext(ctx, &row, `SELECT content, created_at FROM board_messages
		WHERE project = ? AND subscriber_id = ? AND COALESCE(is_system, 0) = 0 ORDER BY id DESC LIMIT 1`, project, subscriberID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", time.Time{}, nil
	}
	if err != nil {
		return "", time.Time{}, err
	}
	at, _ := time.Parse(time.RFC3339, row.CreatedAt)
	return row.Content, at, nil
}

// MentionOf is a board message that mentions a member.
type MentionOf struct {
	ID        int64  `db:"id"`
	Sender    string `db:"subscriber_id"`
	CreatedAt string `db:"created_at"`
}

// MentionsOf lists agents' messages on project since since that mention name or title (as
// "@name" or "@title", any case, ending at a word boundary: "@Dev" is not "@Developer"),
// oldest first, leaving out Coral's own lines and the member's own posts.
func (s *Store) MentionsOf(ctx context.Context, project, name, title string, since time.Time) ([]MentionOf, error) {
	var rows []struct {
		MentionOf
		Content string `db:"content"`
	}
	// The substring test narrows the rows; the word-boundary test below decides.
	err := s.reader().SelectContext(ctx, &rows, `SELECT id, subscriber_id, created_at, content FROM board_messages
		WHERE project = ? AND created_at > ? AND COALESCE(is_system, 0) = 0 AND subscriber_id != ?
		  AND subscriber_id NOT IN ('Coral Task Queue', 'Coral Health Monitor', 'Coral')
		  AND (instr(lower(content), lower('@' || ?)) > 0 OR (? != '' AND instr(lower(content), lower('@' || ?)) > 0))
		ORDER BY id`, project, since.UTC().Format(time.RFC3339), name, name, title, title)
	if err != nil {
		return nil, err
	}
	terms := []string{regexp.QuoteMeta(name)}
	if title != "" {
		terms = append(terms, regexp.QuoteMeta(title))
	}
	re := regexp.MustCompile(`(?i)(^|[^\p{L}\p{N}])@(` + strings.Join(terms, "|") + `)($|[^\p{L}\p{N}])`)
	var out []MentionOf
	for _, r := range rows {
		if re.MatchString(r.Content) {
			out = append(out, r.MentionOf)
		}
	}
	return out, nil
}

// ReviewWait is a task waiting in review (status review_pending): who holds the review (the reviewers of the current round that have not decided; the
// submitter when no round has begun) and since when it was submitted (#11729's stale-review rule).
type ReviewWait struct {
	Task    int64
	With    []string
	Since   time.Time
	Started bool // a round of review has begun
}

// ReviewWaits lists the board's tasks in review, oldest first.
func (s *Store) ReviewWaits(ctx context.Context, project string) ([]ReviewWait, error) {
	var rows []struct {
		ID        int64   `db:"id"`
		Assignee  *string `db:"assigned_to"`
		EditedAt  *string `db:"edited_at"`
		Data      *string `db:"data"`
		CreatedAt string  `db:"created_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT t.id, t.assigned_to, t.edited_at, w.data, t.created_at FROM board_tasks t LEFT JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.status = 'review_pending' ORDER BY t.id`, project); err != nil {
		return nil, err
	}
	var out []ReviewWait
	for _, r := range rows {
		rw := ReviewWait{Task: r.ID}
		var w struct {
			CompletionReview *CompletionReview `json:"completion_review"`
			ReviewRounds     []ReviewRound     `json:"review_rounds"`
		}
		if r.Data != nil {
			_ = json.Unmarshal([]byte(*r.Data), &w)
		}
		stamp := ""
		switch {
		case w.CompletionReview != nil && w.CompletionReview.ReleasedAt != "":
			stamp = w.CompletionReview.ReleasedAt // when it went into review: the slot was released then
		case w.CompletionReview != nil && w.CompletionReview.SubmittedAt != "":
			stamp = w.CompletionReview.SubmittedAt
		case r.EditedAt != nil:
			stamp = *r.EditedAt
		default:
			stamp = r.CreatedAt
		}
		rw.Since, _ = time.Parse(time.RFC3339, stamp)
		if n := len(w.ReviewRounds); n > 0 && w.ReviewRounds[n-1].Result == "" {
			rw.Started = true
			for _, rs := range w.ReviewRounds[n-1].Reviewers {
				if rs.State == "pending" {
					rw.With = append(rw.With, rs.Reviewer)
				}
			}
		}
		if len(rw.With) == 0 && r.Assignee != nil {
			rw.With = []string{*r.Assignee}
		}
		out = append(out, rw)
	}
	return out, nil
}

// LastPostID is the number of a member's latest board post on project (0 when none): the message to answer.
func (s *Store) LastPostID(ctx context.Context, project, subscriberID string) (int64, error) {
	var id int64
	err := s.reader().GetContext(ctx, &id, `SELECT COALESCE(MAX(id), 0) FROM board_messages WHERE project = ? AND subscriber_id = ? AND COALESCE(is_system, 0) = 0`, project, subscriberID)
	return id, err
}
