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
	Relaxed  bool // a hit holds ANY of the words, best first (the near matches offered when nothing holds all of them, #19476)
	Oldest   bool // oldest first (the limit then keeps the oldest); the default is the best match, then newest
}

// WorkHit is one task or goal that matched, in the one shape every source of the search shares.
type WorkHit struct {
	Source   string `json:"source"` // "task", "goal", "message" or "history" (a turn of a past chat: id is its index in the session)
	ID       int64  `json:"id"`
	Session  string `json:"session,omitempty"` // history: the chat session the turn is in
	Title    string `json:"title"`
	Snippet  string `json:"snippet"`
	State    string `json:"state"`
	GoalID   *int64 `json:"goal_id,omitempty"`
	Matched  int    `json:"matched,omitempty"`   // a near match: how many of the words it holds
	Of       int    `json:"of,omitempty"`        // ... out of how many were asked for
	DoneWhen string `json:"done_when,omitempty"` // a goal's done-when, whole (300 characters at most), so a hit answers "when is it done?"
	Assignee string `json:"assignee,omitempty"`  // a task's assignee (#19448): "who has it" without opening it
	At       string `json:"at"`
	Minor    bool   `json:"-"` // a reviewer's own "Review #N" task: it repeats the task it reviews, so a search with no sort named lists it after the real hits
	Rank     int    `json:"-"` // a several-term search: how well the terms stand (WorkRank); the one list is ordered by it first
}

const (
	workSnippetWidth = 320 // wide enough for a goal's whole done-when (300 characters at most) with the words around the match
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
	terms := SearchTerms(text)
	if want["tasks"] {
		var rows []struct {
			ID     int64   `db:"id"`
			Title  string  `db:"title"`
			Body   *string `db:"body"`
			Done   *string `db:"completion_message"`
			Status string  `db:"status"`
			GoalID *int64  `db:"goal_id"`
			Assign *string `db:"assigned_to"`
			At     string  `db:"at"`
		}
		matcher := likeAllTerms
		if q.Relaxed {
			matcher = likeAnyTerms
		}
		match, matchArgs := matcher(terms, "title", "body", "completion_message")
		sqlText := `SELECT id, title, body, completion_message, status, goal_id, assigned_to, ` + updatedAtSQL + ` AS at FROM board_tasks WHERE board_id = ? AND ` + match
		args := append([]any{q.Board}, matchArgs...)
		if q.State != "" {
			cl, ca := stateClause("status", q.State, openTaskStates)
			sqlText += cl
			args = append(args, ca...)
		}
		if q.GoalID != 0 {
			sqlText += " AND goal_id = ?"
			args = append(args, q.GoalID)
		}
		if q.Assignee != "" {
			sqlText += " AND LOWER(TRIM(assigned_to)) = ?"
			args = append(args, strings.ToLower(strings.TrimSpace(q.Assignee)))
		}
		if q.Since != "" {
			sqlText += " AND " + updatedAtSQL + " >= ?"
			args = append(args, q.Since)
		}
		if q.Until != "" {
			sqlText += " AND " + updatedAtSQL + " < ?"
			args = append(args, q.Until)
		}
		if q.Oldest { // two literal branches: the tie-break lint reads the text of each
			sqlText += " ORDER BY at ASC, id ASC LIMIT ?"
		} else {
			sqlText += " ORDER BY at DESC, id DESC LIMIT ?"
		}
		args = append(args, limit+1)
		if err = s.reader().SelectContext(ctx, &rows, sqlText, args...); err != nil {
			return nil, false, err
		}
		for _, r := range rows {
			h := WorkHit{Source: "task", ID: r.ID, Title: r.Title, Snippet: WorkSnippet(text, deref(r.Done), deref(r.Body), r.Title), State: r.Status, GoalID: r.GoalID, Assignee: deref(r.Assign), Minor: strings.HasPrefix(r.Title, "Review #"), At: r.At, Rank: WorkRank(terms, r.Title, r.Title, deref(r.Body), deref(r.Done))}
			if q.Relaxed {
				h.Matched, h.Of = termsHeld(terms, r.Title, deref(r.Body), deref(r.Done)), len(terms)
				h.Rank = h.Matched
			}
			hits = append(hits, h)
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
		matcher := likeAllTerms
		if q.Relaxed {
			matcher = likeAnyTerms
		}
		match, matchArgs := matcher(terms, "title", "outcome", "done_when", "closed_reason")
		sqlText := `SELECT id, title, outcome, done_when, closed_reason, state, updated_at FROM board_goals WHERE board_id = ? AND ` + match
		args := append([]any{q.Board}, matchArgs...)
		if q.State != "" {
			cl, ca := stateClause("state", q.State, openGoalStates)
			sqlText += cl
			args = append(args, ca...)
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
			if q.Oldest {
				sqlText += " ORDER BY updated_at ASC, id ASC LIMIT ?"
			} else {
				sqlText += " ORDER BY updated_at DESC, id DESC LIMIT ?"
			}
			args = append(args, limit+1)
			if err = s.reader().SelectContext(ctx, &rows, sqlText, args...); err != nil {
				return nil, false, err
			}
		}
		for _, r := range rows {
			h := WorkHit{Source: "goal", ID: r.ID, Title: r.Title, Snippet: WorkSnippet(text, r.Done, r.Outcome, r.Closed, r.Title), State: r.State, DoneWhen: r.Done, At: r.At, Rank: WorkRank(terms, r.Title, r.Title, r.Outcome, r.Done, r.Closed)}
			if q.Relaxed {
				h.Matched, h.Of = termsHeld(terms, r.Title, r.Outcome, r.Done, r.Closed), len(terms)
				h.Rank = h.Matched
			}
			hits = append(hits, h)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Rank != hits[j].Rank && !q.Oldest {
			return hits[i].Rank > hits[j].Rank
		}
		if hits[i].At != hits[j].At {
			return (hits[i].At > hits[j].At) != q.Oldest
		}
		return (hits[i].ID > hits[j].ID) != q.Oldest
	})
	if len(hits) > limit {
		hits, more = hits[:limit], true
	}
	return hits, more, nil
}

// The states "open" stands for (#19476): a task still to do or being done, a goal not yet closed.
var (
	openTaskStates = []string{"pending", "in_progress", "blocked", "review_pending", "draft"}
	openGoalStates = []string{"proposed", "active", "blocked"}
)

// stateClause is the SQL for a state filter on column col: one state, or "open" for the open ones.
func stateClause(col, state string, open []string) (string, []any) {
	if state != "open" {
		return " AND " + col + " = ?", []any{state}
	}
	args := make([]any, len(open))
	for i, st := range open {
		args[i] = st
	}
	return " AND " + col + " IN (?" + strings.Repeat(",?", len(open)-1) + ")", args
}

// likeAnyTerms is the SQL that holds when at least one term is in one of the columns.
func likeAnyTerms(terms []string, cols ...string) (string, []any) {
	var ors []string
	var args []any
	for _, t := range terms {
		for _, c := range cols {
			ors = append(ors, c+` LIKE ? ESCAPE '\'`)
			args = append(args, "%"+likeEscape(t)+"%")
		}
	}
	return "(" + strings.Join(ors, " OR ") + ")", args
}

// termsHeld is how many of the terms are somewhere in the fields.
func termsHeld(terms []string, fields ...string) int {
	n := 0
	for _, t := range terms {
		for _, f := range fields {
			if strings.Contains(strings.ToLower(f), t) {
				n++
				break
			}
		}
	}
	return n
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// likeAllTerms is the SQL that holds when every term is in one of the columns (LIKE, '%' and '_' literal): the terms in any order, each in any column.
func likeAllTerms(terms []string, cols ...string) (string, []any) {
	var parts []string
	var args []any
	for _, t := range terms {
		var ors []string
		for _, c := range cols {
			ors = append(ors, c+` LIKE ? ESCAPE '\'`)
			args = append(args, "%"+likeEscape(t)+"%")
		}
		parts = append(parts, "("+strings.Join(ors, " OR ")+")")
	}
	return strings.Join(parts, " AND "), args
}

// WorkSnippet is the field that holds the most of the search's terms (the first on a tie: callers list the answer first, a task's completion message or a goal's done-when, then the body and the title it is shown beside), on one line (control characters dropped, whitespace joined) and cut to about workSnippetWidth runes around the first term in it.
func WorkSnippet(text string, fields ...string) string {
	terms := SearchTerms(text)
	pick, best := "", 0
	for _, f := range fields {
		lf := strings.ToLower(f)
		n := 0
		for _, t := range terms {
			if strings.Contains(lf, t) {
				n++
			}
		}
		if n > best {
			pick, best = f, n
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
	lc := strings.ToLower(clean)
	first := -1
	for _, t := range terms {
		if i := strings.Index(lc, t); i >= 0 && (first < 0 || i < first) {
			first = i
		}
	}
	if first > 0 {
		start = len([]rune(clean[:first])) - 40
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
