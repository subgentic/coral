package board

import (
	"context"
	"sort"
	"strings"
	"unicode"
)

// WorkQuery is a search of a board's tasks and goals (#19161, coral-search slice 1). Board is the board KEY the server took from the caller's launch record: nothing a request names picks it.
type WorkQuery struct {
	Board    string
	Text     string
	Sources  []string // "tasks" and/or "goals"; empty searches both
	State    string   // a task status or a goal state
	GoalID   int64    // tasks of this goal, and this goal; 0 for any
	Assignee string   // tasks assigned to this member (case-insensitive)
	Since    string   // at >= (UTC RFC 3339)
	Until    string   // at <  (UTC RFC 3339)
	Limit    int
}

// WorkHit is one task or goal that matched, in the one shape every source of the search shares.
type WorkHit struct {
	Source  string `json:"source"` // "task", "goal", "message" or "history" (a turn of a past chat: id is its index in the session)
	ID      int64  `json:"id"`
	Session string `json:"session,omitempty"` // history: the chat session the turn is in
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
	State   string `json:"state"`
	GoalID  *int64 `json:"goal_id,omitempty"`
	At      string `json:"at"`
}

const (
	workSnippetWidth = 160
	workMaxLimit     = 100
)

// SearchWork finds the board's tasks and goals whose text holds q.Text (case-insensitive, '%' and '_' literal): tasks by title, body and completion message; goals by title, outcome, done-when and closed reason.
// Newest first (a task by its last change, a goal by its update), at most Limit; more says there were others.
func (s *Store) SearchWork(ctx context.Context, q WorkQuery) (hits []WorkHit, more bool, err error) {
	text := strings.TrimSpace(q.Text)
	if q.Board == "" || text == "" {
		return nil, false, nil
	}
	limit := q.Limit
	if limit <= 0 || limit > workMaxLimit {
		limit = workMaxLimit
	}
	want := map[string]bool{}
	for _, src := range q.Sources {
		want[src] = true
	}
	if len(want) == 0 {
		want["tasks"], want["goals"] = true, true
	}
	pat := "%" + likeEscape(text) + "%"
	if want["tasks"] {
		var rows []struct {
			ID     int64   `db:"id"`
			Title  string  `db:"title"`
			Body   *string `db:"body"`
			Done   *string `db:"completion_message"`
			Status string  `db:"status"`
			GoalID *int64  `db:"goal_id"`
			At     string  `db:"at"`
		}
		sqlText := `SELECT id, title, body, completion_message, status, goal_id, ` + updatedAtSQL + ` AS at FROM board_tasks WHERE board_id = ?
 AND (title LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\' OR completion_message LIKE ? ESCAPE '\')`
		args := []any{q.Board, pat, pat, pat}
		if q.State != "" {
			sqlText += " AND status = ?"
			args = append(args, q.State)
		}
		if q.GoalID != 0 {
			sqlText += " AND goal_id = ?"
			args = append(args, q.GoalID)
		}
		if q.Assignee != "" {
			sqlText += " AND LOWER(assigned_to) = ?"
			args = append(args, strings.ToLower(q.Assignee))
		}
		if q.Since != "" {
			sqlText += " AND " + updatedAtSQL + " >= ?"
			args = append(args, q.Since)
		}
		if q.Until != "" {
			sqlText += " AND " + updatedAtSQL + " < ?"
			args = append(args, q.Until)
		}
		sqlText += " ORDER BY at DESC, id DESC LIMIT ?"
		args = append(args, limit+1)
		if err = s.reader().SelectContext(ctx, &rows, sqlText, args...); err != nil {
			return nil, false, err
		}
		for _, r := range rows {
			hits = append(hits, WorkHit{Source: "task", ID: r.ID, Title: r.Title, Snippet: WorkSnippet(text, r.Title, deref(r.Body), deref(r.Done)), State: r.Status, GoalID: r.GoalID, At: r.At})
		}
	}
	if want["goals"] {
		var rows []struct {
			ID      int64  `db:"id"`
			Title   string `db:"title"`
			Outcome string `db:"outcome"`
			Done    string `db:"done_when"`
			Closed  string `db:"closed_reason"`
			State   string `db:"state"`
			At      string `db:"updated_at"`
		}
		sqlText := `SELECT id, title, outcome, done_when, closed_reason, state, updated_at FROM board_goals WHERE board_id = ?
 AND (title LIKE ? ESCAPE '\' OR outcome LIKE ? ESCAPE '\' OR done_when LIKE ? ESCAPE '\' OR closed_reason LIKE ? ESCAPE '\')`
		args := []any{q.Board, pat, pat, pat, pat}
		if q.State != "" {
			sqlText += " AND state = ?"
			args = append(args, q.State)
		}
		if q.GoalID != 0 {
			sqlText += " AND id = ?"
			args = append(args, q.GoalID)
		}
		if q.Assignee != "" { // goals have no assignee: an assignee filter is about tasks
			rows = nil
		} else {
			if q.Since != "" {
				sqlText += " AND updated_at >= ?"
				args = append(args, q.Since)
			}
			if q.Until != "" {
				sqlText += " AND updated_at < ?"
				args = append(args, q.Until)
			}
			sqlText += " ORDER BY updated_at DESC, id DESC LIMIT ?"
			args = append(args, limit+1)
			if err = s.reader().SelectContext(ctx, &rows, sqlText, args...); err != nil {
				return nil, false, err
			}
		}
		for _, r := range rows {
			hits = append(hits, WorkHit{Source: "goal", ID: r.ID, Title: r.Title, Snippet: WorkSnippet(text, r.Title, r.Outcome, r.Done, r.Closed), State: r.State, At: r.At})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].At != hits[j].At {
			return hits[i].At > hits[j].At
		}
		return hits[i].ID > hits[j].ID
	})
	if len(hits) > limit {
		hits, more = hits[:limit], true
	}
	return hits, more, nil
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// WorkSnippet is the first field that holds text, on one line (control characters dropped, whitespace joined) and cut to about workSnippetWidth runes around the match.
func WorkSnippet(text string, fields ...string) string {
	lt := strings.ToLower(text)
	pick := ""
	for _, f := range fields {
		if strings.Contains(strings.ToLower(f), lt) {
			pick = f
			break
		}
	}
	clean := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, pick)), " ")
	r := []rune(clean)
	if len(r) <= workSnippetWidth {
		return clean
	}
	start := 0
	if i := strings.Index(strings.ToLower(clean), lt); i > 0 {
		start = len([]rune(clean[:i])) - 40
	}
	if start < 0 {
		start = 0
	}
	if start+workSnippetWidth > len(r) {
		start = len(r) - workSnippetWidth
	}
	out := string(r[start : start+workSnippetWidth])
	if start > 0 {
		out = "…" + out
	}
	if start+workSnippetWidth < len(r) {
		out += "…"
	}
	return out
}
