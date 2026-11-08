package board

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

// The summaries of the list pages (#14440): one TaskSummary per task, so a page of many tasks is one read and the entries are read only when a row opens. Every query carries the board; the sources are read for
// the page's task ids together (the counts and newest rows of replies and decisions in grouped queries, the files in the team artifact scan the Files page already uses), never one query per task. The
// asks go through askInfo once per question to the Operator, as the Needs you page does (bounded by threadSourceCap).

// ThreadCounts is what a task's thread holds, by kind.
type ThreadCounts struct {
	Asks      int `json:"asks"`
	Files     int `json:"files"`
	Replies   int `json:"replies"`
	Decisions int `json:"decisions"`
}

// ThreadLatest is the newest entry of a thread: its kind, time, first line (redacted, cut) and who.
type ThreadLatest struct {
	Kind  string `json:"kind"`
	At    string `json:"at"`
	Line  string `json:"line"`
	Actor string `json:"actor,omitempty"`
}

// ThreadLastDecision is the Operator's latest decision on the task.
type ThreadLastDecision struct {
	Action string `json:"action"`
	At     string `json:"at"`
}

// TaskSummary is the collapsed row of a task's thread.
type TaskSummary struct {
	TaskID       int64               `json:"task_id"`
	Title        string              `json:"title"`
	Status       string              `json:"status"`
	GoalID       int64               `json:"goal_id,omitempty"`
	GoalTitle    string              `json:"goal_title,omitempty"`
	Counts       ThreadCounts        `json:"counts"`
	Waiting      int                 `json:"waiting"` // open questions to the Operator on this task
	Latest       *ThreadLatest       `json:"latest"`
	LastDecision *ThreadLastDecision `json:"last_decision"`
}

// ThreadsQuery asks for a page of task summaries of one team, optionally of one goal, newest activity first.
type ThreadsQuery struct {
	Team   string
	GoalID int64
	State  string // waiting, decided or all ("" is all)
	Limit  int
	After  string
	// Redact, Operator and Actor are ThreadQuery's.
	Redact   func(string) (string, bool)
	Operator string
	Actor    string
}

// ThreadsPage is one page of summaries.
type ThreadsPage struct {
	Threads []TaskSummary `json:"threads"`
	More    bool          `json:"more"`
	Cursor  string        `json:"cursor,omitempty"`
	Capped  bool          `json:"capped,omitempty"`
}

// ThreadSummariesOf reads the summaries of the given tasks of the team.
func (s *Store) threadSummariesOf(ctx context.Context, tq ThreadQuery, tasks []Task) ([]TaskSummary, bool, error) {
	if tq.Operator == "" {
		tq.Operator = OperatorName
	}
	out := make([]TaskSummary, len(tasks))
	idx := map[int64]int{}
	ids := make([]int64, len(tasks))
	for i, t := range tasks {
		out[i] = TaskSummary{TaskID: t.ID, Title: t.Title, Status: t.Status}
		if t.GoalID != nil {
			out[i].GoalID = *t.GoalID
		}
		idx[t.ID], ids[i] = i, t.ID
		out[i].Latest = taskLatest(tq, t)
	}
	if len(ids) == 0 {
		return out, false, nil
	}
	capped := false
	in, inArgs := idList(ids)

	// goal titles (one query for the page's goals, the board in it)
	goalIDs := map[int64]bool{}
	for _, t := range out {
		if t.GoalID > 0 {
			goalIDs[t.GoalID] = true
		}
	}
	if len(goalIDs) > 0 {
		var gids []int64
		for g := range goalIDs {
			gids = append(gids, g)
		}
		gin, gargs := idList(gids)
		var goals []struct {
			ID    int64  `db:"id"`
			Title string `db:"title"`
		}
		if err := s.reader().SelectContext(ctx, &goals, `SELECT id, title FROM board_goals WHERE board_id = ? AND id IN (`+gin+`)`, append([]any{tq.Team}, gargs...)...); err != nil {
			return nil, false, err
		}
		titles := map[int64]string{}
		for _, g := range goals {
			titles[g.ID] = g.Title
		}
		for i := range out {
			out[i].GoalTitle = titles[out[i].GoalID]
		}
	}

	// questions to the Operator
	var askRows []struct {
		askRow
		TaskID  int64  `db:"task_id"`
		Content string `db:"content"`
	}
	if err := s.reader().SelectContext(ctx, &askRows, `SELECT a.message_id, a.asker, a.asked, a.created_at, s.task_id, COALESCE(m.content, '') AS content
		FROM board_asks a JOIN board_ask_subjects s ON s.message_id = a.message_id AND s.project = a.project
		LEFT JOIN board_messages m ON m.id = a.message_id AND m.project = a.project
		WHERE a.project = ? AND s.task_id IN (`+in+`) ORDER BY a.message_id DESC LIMIT ?`, append(append([]any{tq.Team}, inArgs...), threadSourceCap+1)...); err != nil {
		return nil, false, err
	}
	if len(askRows) > threadSourceCap {
		askRows, capped = askRows[:threadSourceCap], true
	}
	var asks []askRow
	byAsk := map[int64]int{}
	for i, r := range askRows {
		if askedOperator(r.askRow, tq.Operator) {
			asks = append(asks, r.askRow)
			byAsk[r.MessageID] = i
		}
	}
	states, err := s.askStates(ctx, tq.Team, tq.Operator, asks)
	if err != nil {
		return nil, false, err
	}
	for _, a := range asks { // newest first: the first one seen per task is its newest
		r := askRows[byAsk[a.MessageID]]
		i, ok := idx[r.TaskID]
		if !ok {
			continue
		}
		out[i].Counts.Asks++
		if states[a.MessageID] == "open" {
			out[i].Waiting++
		}
		line, _ := ThreadQuery{Redact: tq.Redact}.cut(r.Content, ThreadLineCap, true)
		consider(&out[i], ThreadLatest{Kind: "ask", At: utc(a.CreatedAt), Line: line, Actor: a.Asker})
	}

	// replies: the count and the newest, in two grouped queries
	var replyCounts []struct {
		TaskID int64 `db:"task_id"`
		N      int   `db:"n"`
		MaxID  int64 `db:"max_id"`
	}
	if err := s.reader().SelectContext(ctx, &replyCounts, `SELECT task_id, COUNT(*) AS n, MAX(id) AS max_id FROM board_messages WHERE project = ? AND task_id IN (`+in+`) GROUP BY task_id`, append([]any{tq.Team}, inArgs...)...); err != nil {
		return nil, false, err
	}
	var newest []int64
	for _, r := range replyCounts {
		if i, ok := idx[r.TaskID]; ok {
			out[i].Counts.Replies = r.N
			newest = append(newest, r.MaxID)
		}
	}
	if len(newest) > 0 {
		nin, nargs := idList(newest)
		var rows []struct {
			From    string `db:"subscriber_id"`
			Content string `db:"content"`
			At      string `db:"created_at"`
			TaskID  int64  `db:"task_id"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT subscriber_id, content, created_at, task_id FROM board_messages WHERE project = ? AND id IN (`+nin+`)`, append([]any{tq.Team}, nargs...)...); err != nil {
			return nil, false, err
		}
		for _, r := range rows {
			if i, ok := idx[r.TaskID]; ok {
				line, _ := ThreadQuery{Redact: tq.Redact}.cut(r.Content, ThreadLineCap, true)
				consider(&out[i], ThreadLatest{Kind: "reply", At: utc(r.At), Line: line, Actor: r.From})
			}
		}
	}

	// the Operator's decisions: the count and the newest row per task
	actorSQL, actorArgs := "", []any{}
	if tq.Actor != "" {
		actorSQL, actorArgs = " AND actor = ?", []any{tq.Actor}
	}
	var decCounts []struct {
		TaskID int64 `db:"task_id"`
		N      int   `db:"n"`
		MaxID  int64 `db:"max_id"`
	}
	if err := s.reader().SelectContext(ctx, &decCounts, `SELECT task_id, COUNT(*) AS n, MAX(id) AS max_id FROM operator_actions WHERE team = ? AND task_id IN (`+in+`)`+actorSQL+` GROUP BY task_id`,
		append(append([]any{tq.Team}, inArgs...), actorArgs...)...); err != nil {
		return nil, false, err
	}
	var lastIDs []int64
	for _, r := range decCounts {
		if i, ok := idx[r.TaskID]; ok {
			out[i].Counts.Decisions = r.N
			lastIDs = append(lastIDs, r.MaxID)
		}
	}
	if len(lastIDs) > 0 {
		lin, largs := idList(lastIDs)
		var rows []struct {
			Action string `db:"action"`
			At     string `db:"at"`
			Actor  string `db:"actor"`
			Title  string `db:"title"`
			TaskID int64  `db:"task_id"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT action, at, actor, title, task_id FROM operator_actions WHERE team = ? AND id IN (`+lin+`)`, append([]any{tq.Team}, largs...)...); err != nil {
			return nil, false, err
		}
		for _, r := range rows {
			if i, ok := idx[r.TaskID]; ok {
				out[i].LastDecision = &ThreadLastDecision{Action: r.Action, At: utc(r.At)}
				line, _ := ThreadQuery{Redact: tq.Redact}.cut(r.Action+" "+r.Title, ThreadLineCap, true)
				consider(&out[i], ThreadLatest{Kind: "decision", At: utc(r.At), Line: line, Actor: r.Actor})
			}
		}
	}

	// files: one scan of the team's tasks that reference files
	files, truncated, err := s.ListTeamArtifactTasks(ctx, tq.Team, MaxTeamArtifactTaskScan)
	if err != nil {
		return nil, false, err
	}
	capped = capped || truncated
	for _, t := range files {
		i, ok := idx[t.TaskID]
		if !ok {
			continue
		}
		n := 0
		for _, a := range t.Artifacts {
			if strings.TrimPrefix(a.Digest, "sha256:") != "" {
				n++
			}
		}
		out[i].Counts.Files = n
		if n > 0 {
			at := t.CompletedAt
			if at == "" {
				at = t.CreatedAt
			}
			name, _ := ThreadQuery{Redact: tq.Redact}.cut(t.Artifacts[0].Name, ThreadLineCap, true)
			consider(&out[i], ThreadLatest{Kind: "file", At: utc(at), Line: name, Actor: t.CompletedBy})
		}
	}
	return out, capped, nil
}

// taskLatest is the task's own newest event (created, claimed or finished), the floor of its latest entry.
func taskLatest(tq ThreadQuery, t Task) *ThreadLatest {
	at, kind, by := utc(t.CreatedAt), "created", t.CreatedBy
	if t.ClaimedAt != nil && *t.ClaimedAt != "" && utc(*t.ClaimedAt) > at {
		at, kind = utc(*t.ClaimedAt), "claimed"
		if t.AssignedTo != nil {
			by = *t.AssignedTo
		}
	}
	if t.CompletedAt != nil && *t.CompletedAt != "" && utc(*t.CompletedAt) > at {
		at, kind = utc(*t.CompletedAt), t.Status
		if t.CompletedBy != nil {
			by = *t.CompletedBy
		}
	}
	line, _ := tq.cut(t.Title, ThreadLineCap, true)
	return &ThreadLatest{Kind: "task_event", At: at, Line: kind + ": " + line, Actor: by}
}

// consider keeps l as the summary's latest when it is newer.
func consider(s *TaskSummary, l ThreadLatest) {
	if s.Latest == nil || l.At > s.Latest.At {
		cp := l
		s.Latest = &cp
	}
}

// ThreadSummaries reads one page of task summaries of the team (optionally of one goal) by newest activity, filtered by state: waiting keeps the tasks with an open question to the Operator,
// decided those with a decision of theirs, all every task.
func (s *Store) ThreadSummaries(ctx context.Context, q ThreadsQuery) (*ThreadsPage, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = ThreadDefaultLimit
	}
	if limit > ThreadMaxLimit {
		limit = ThreadMaxLimit
	}
	var after *threadKey
	if q.After != "" {
		k, err := decodeCursor(q.After)
		if err != nil {
			return nil, err
		}
		after = &k
	}
	if q.GoalID > 0 {
		if g, err := s.GetGoal(ctx, q.Team, q.GoalID); err != nil || g == nil {
			return nil, ErrThreadNotFound
		}
	}
	where, args := "board_id = ?", []any{q.Team}
	if q.GoalID > 0 {
		where, args = where+" AND goal_id = ?", append(args, q.GoalID)
	} else {
		where += " AND goal_id IS NOT NULL" // a list of threads is the tasks that belong to a goal: a task of no goal has no thread to group under
	}
	var tasks []Task
	if err := s.reader().SelectContext(ctx, &tasks, `SELECT id, board_id, title, status, created_by, assigned_to, completed_by, created_at, claimed_at, completed_at, goal_id FROM board_tasks WHERE `+where+` ORDER BY id DESC LIMIT ?`,
		append(args, threadSourceCap+1)...); err != nil {
		return nil, err
	}
	page := &ThreadsPage{Threads: []TaskSummary{}}
	if len(tasks) > threadSourceCap {
		tasks, page.Capped = tasks[:threadSourceCap], true
	}
	tq := ThreadQuery{Team: q.Team, Redact: q.Redact, Operator: q.Operator, Actor: q.Actor}
	sums, capped, err := s.threadSummariesOf(ctx, tq, tasks)
	if err != nil {
		return nil, err
	}
	page.Capped = page.Capped || capped
	kept := sums[:0]
	for _, t := range sums {
		switch q.State {
		case "waiting":
			if t.Waiting == 0 {
				continue
			}
		case "decided":
			if t.LastDecision == nil {
				continue
			}
		}
		kept = append(kept, t)
	}
	// newest activity first; the task id breaks a tie
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].Latest.At != kept[j].Latest.At {
			return kept[i].Latest.At > kept[j].Latest.At
		}
		return kept[i].TaskID > kept[j].TaskID
	})
	start := 0
	if after != nil {
		start = len(kept)
		for i, t := range kept {
			k := threadKey{t.Latest.At, 0, strconv.FormatInt(t.TaskID, 10)}
			// a descending list: the next row is the first strictly after the cursor in that order
			if k.at < after.at || (k.at == after.at && k.id < after.id) {
				start = i
				break
			}
		}
	}
	rest := kept[start:]
	if len(rest) > limit {
		page.Threads, page.More = rest[:limit], true
		last := page.Threads[limit-1]
		page.Cursor = encodeCursor(threadKey{last.Latest.At, 0, strconv.FormatInt(last.TaskID, 10)})
	} else {
		page.Threads = append(page.Threads, rest...)
	}
	return page, nil
}
