package board

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// A thread is the story of one goal or one task (goal #233, S3, #14440; the design note coral://artifacts/7308bfa149eb7b7b8e8566f40dc9d691851f042b3e4cc0b3e76334401209403d): the questions asked of
// the Operator about it, the files its tasks produced, the agents' replies through the task route and the task's and goal's own events, in one order. Every read here is qualified by the board
// (a task or goal id that belongs to another board is not found), bounded (each source reads at most threadSourceCap rows), and returns text only after the caller's redaction.
//
// The Operator's own decisions (Activity rows) are joined by the caller from the Activity record's goal and task ids (S1); this package reads the board's own tables.

const (
	// ThreadDefaultLimit and ThreadMaxLimit bound a page of entries (and of summaries).
	ThreadDefaultLimit = 50
	ThreadMaxLimit     = 200
	// threadSourceCap is the most rows one source (asks, replies, tasks, files) is read for one thread or one page of summaries.
	threadSourceCap = 500
	// ThreadLineCap and ThreadTextCap cut a first line and an excerpt, in characters, after redaction.
	ThreadLineCap = 120
	ThreadTextCap = 400
	// ThreadWithheld stands for a text the redaction could not clear.
	ThreadWithheld = "(text withheld)"
)

// ErrThreadNotFound: the goal or task is not one of the board (or there is no such id).
var ErrThreadNotFound = errors.New("no such goal or task on this team")

// ErrThreadCursor: the cursor is not one this read gave.
var ErrThreadCursor = errors.New("invalid cursor")

// ThreadQuery asks for the entries of one goal (GoalID) or one task (TaskID, optionally with its GoalID to narrow a goal read). Exactly one of the two is set by the caller's validation.
type ThreadQuery struct {
	Team   string
	GoalID int64
	TaskID int64
	Order  string // "asc" (default) or "desc"
	Limit  int
	After  string // the cursor of the last entry of the page before
	// Redact clears a text before it is cut: false means it could not be cleared and ThreadWithheld stands for it. nil means every text is withheld (never an unredacted one).
	Redact func(string) (string, bool)
	// Operator names the member whose open questions count (board.OperatorName by default).
	Operator string
	// Actor limits the Operator's decisions to one actor's rows (a Coral Hub team's owner reads their own, #12070); "" is every row of this computer's record.
	Actor string
	Now   time.Time
}

// ThreadEntry is one entry of a thread: every entry has At, Kind and ID; the other fields are set by Kind.
type ThreadEntry struct {
	At     string `json:"at"`
	Kind   string `json:"kind"` // ask, file, reply, task_event, goal_event (decision entries are added by the caller from the Activity record)
	ID     string `json:"id"`
	TaskID int64  `json:"task_id,omitempty"`
	// ask
	Asker     string `json:"asker,omitempty"`
	Line      string `json:"line,omitempty"`
	State     string `json:"state,omitempty"` // ask: open, answered, closed; file: the review state
	MessageID int64  `json:"message_id,omitempty"`
	// file
	Digest string `json:"digest,omitempty"`
	Name   string `json:"name,omitempty"`
	By     string `json:"by,omitempty"`
	// reply
	From      string `json:"from,omitempty"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	// task_event, goal_event
	Event string `json:"event,omitempty"`
	// decision: the Operator's Activity row (action, who, from where, the item and its name at action time, their words); AskID is the question's message id when the item is one
	Action   string `json:"action,omitempty"`
	Actor    string `json:"actor,omitempty"`
	Source   string `json:"source,omitempty"`
	ItemKind string `json:"item_kind,omitempty"`
	ItemID   string `json:"item_id,omitempty"`
	Title    string `json:"title,omitempty"`
	Note     string `json:"note,omitempty"`
	AskID    int64  `json:"ask_id,omitempty"`
}

// ThreadHeader describes the thread read.
type ThreadHeader struct {
	Kind      string `json:"kind"`
	Team      string `json:"team"`
	GoalID    int64  `json:"goal_id,omitempty"`
	TaskID    int64  `json:"task_id,omitempty"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	GoalTitle string `json:"goal_title,omitempty"`
	TaskTitle string `json:"task_title,omitempty"`
}

// ThreadPage is one page of a thread.
type ThreadPage struct {
	Thread  ThreadHeader  `json:"thread"`
	Tasks   []TaskSummary `json:"tasks,omitempty"` // a goal thread: one summary per task
	Entries []ThreadEntry `json:"entries"`
	More    bool          `json:"more"`
	Cursor  string        `json:"cursor,omitempty"`
	Capped  bool          `json:"capped,omitempty"` // a source hit its bound: older entries of it are not in this answer
}

// kindRank orders two entries of the same instant: the cause before its effect.
func kindRank(kind string) int {
	switch kind {
	case "goal_event":
		return 0
	case "task_event":
		return 1
	case "ask":
		return 2
	case "file":
		return 3
	case "reply":
		return 4
	case "decision":
		return 5
	}
	return 6
}

type threadKey struct {
	at   string
	rank int
	id   string
}

func (e ThreadEntry) key() threadKey { return threadKey{e.At, kindRank(e.Kind), e.ID} }

func (a threadKey) less(b threadKey) bool {
	if a.at != b.at {
		return a.at < b.at
	}
	if a.rank != b.rank {
		return a.rank < b.rank
	}
	return a.id < b.id
}

func encodeCursor(k threadKey) string {
	return base64.RawURLEncoding.EncodeToString([]byte(k.at + "|" + strconv.Itoa(k.rank) + "|" + k.id))
}

// decodeCursor is strict: three parts, a time, a rank in range and an id with no separator in it.
func decodeCursor(c string) (threadKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return threadKey{}, ErrThreadCursor
	}
	parts := strings.SplitN(string(raw), "|", 3)
	if len(parts) != 3 || parts[2] == "" {
		return threadKey{}, ErrThreadCursor
	}
	if _, err := time.Parse(time.RFC3339Nano, parts[0]); err != nil {
		return threadKey{}, ErrThreadCursor
	}
	rank, err := strconv.Atoi(parts[1])
	if err != nil || rank < 0 || rank > 6 {
		return threadKey{}, ErrThreadCursor
	}
	return threadKey{parts[0], rank, parts[2]}, nil
}

// cut redacts a text and then cuts it to n characters; truncated is true when the cut removed some.
func (q ThreadQuery) cut(text string, n int, firstLineOnly bool) (out string, truncated bool) {
	if firstLineOnly {
		if i := strings.IndexAny(text, "\r\n"); i >= 0 {
			text = text[:i]
		}
	}
	if q.Redact == nil {
		return ThreadWithheld, false
	}
	red, ok := q.Redact(text)
	if !ok {
		return ThreadWithheld, false
	}
	red = strings.TrimSpace(red)
	if r := []rune(red); len(r) > n {
		return string(r[:n]), true
	}
	return red, false
}

func utc(s string) string {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC().Format(time.RFC3339Nano)
	}
	return s
}

// threadScope is the tasks (and goal) a thread covers, read with the board in every query.
type threadScope struct {
	goal    *Goal
	tasks   []Task
	taskIDs []int64
	capped  bool
}

func (s *Store) threadScope(ctx context.Context, q ThreadQuery) (*threadScope, error) {
	sc := &threadScope{}
	if q.GoalID > 0 {
		g, err := s.GetGoal(ctx, q.Team, q.GoalID)
		if err != nil || g == nil {
			return nil, ErrThreadNotFound
		}
		sc.goal = g
	}
	if q.TaskID > 0 {
		t, err := s.GetTask(ctx, q.Team, q.TaskID)
		if err != nil || t == nil {
			return nil, ErrThreadNotFound
		}
		if q.GoalID > 0 && (t.GoalID == nil || *t.GoalID != q.GoalID) {
			return nil, ErrThreadNotFound // a task of another goal is not in this one
		}
		sc.tasks = []Task{*t}
	} else if q.GoalID > 0 {
		var rows []Task
		if err := s.reader().SelectContext(ctx, &rows, `SELECT id, board_id, title, status, created_by, assigned_to, completed_by, created_at, claimed_at, completed_at, goal_id
			FROM board_tasks WHERE board_id = ? AND goal_id = ? ORDER BY id DESC LIMIT ?`, q.Team, q.GoalID, threadSourceCap+1); err != nil {
			return nil, err
		}
		if len(rows) > threadSourceCap {
			rows, sc.capped = rows[:threadSourceCap], true
		}
		sc.tasks = rows
	}
	for _, t := range sc.tasks {
		sc.taskIDs = append(sc.taskIDs, t.ID)
	}
	return sc, nil
}

func idList(ids []int64) (string, []any) {
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i], args[i] = "?", id
	}
	return strings.Join(ph, ","), args
}

// askState is where a question to the Operator stands: open while the Operator still owes an answer, closed by hand, else answered.
func (s *Store) askStates(ctx context.Context, team, operator string, asks []askRow) (map[int64]string, error) {
	out := map[int64]string{}
	if len(asks) == 0 {
		return out, nil
	}
	subs, err := s.subscriberIndex(ctx, team)
	if err != nil {
		return nil, err
	}
	closedRows := []struct {
		ID int64 `db:"message_id"`
	}{}
	if err := s.reader().SelectContext(ctx, &closedRows, `SELECT message_id FROM board_ask_closed WHERE project = ?`, team); err != nil {
		return nil, err
	}
	closed := map[int64]bool{}
	for _, c := range closedRows {
		closed[c.ID] = true
	}
	for _, a := range asks {
		info, err := s.askInfo(ctx, team, a, subs)
		if err != nil {
			return nil, err
		}
		state := "answered"
		for _, m := range info.Open {
			if strings.EqualFold(m, operator) {
				state = "open"
			}
		}
		if state != "open" && closed[a.MessageID] {
			state = "closed"
		}
		out[a.MessageID] = state
	}
	return out, nil
}

// askedOperator reports whether the question's asked list names the Operator: the same visibility rule as the Needs you page (OpenAsksOf), so a thread shows the Operator only their own questions.
func askedOperator(a askRow, operator string) bool {
	return strings.Contains(strings.ToLower(a.Asked), strings.ToLower(strconv.Quote(operator)))
}

// ThreadEntries reads one page of a thread.
func (s *Store) ThreadEntries(ctx context.Context, q ThreadQuery) (*ThreadPage, error) {
	if q.Operator == "" {
		q.Operator = OperatorName
	}
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
	sc, err := s.threadScope(ctx, q)
	if err != nil {
		return nil, err
	}
	page := &ThreadPage{Entries: []ThreadEntry{}}
	page.Capped = sc.capped
	page.Thread = s.threadHeader(ctx, q, sc)
	if q.TaskID == 0 { // a goal read: one summary per task of the goal
		sums, capped, err := s.threadSummariesOf(ctx, q, sc.tasks)
		if err != nil {
			return nil, err
		}
		page.Tasks, page.Capped = sums, page.Capped || capped
	}

	var entries []ThreadEntry
	// goal and task events
	if sc.goal != nil {
		entries = append(entries, ThreadEntry{At: utc(sc.goal.CreatedAt), Kind: "goal_event", ID: fmt.Sprintf("goal:%d:created", sc.goal.ID), Event: "created", By: sc.goal.CreatedBy})
		if sc.goal.ClosedAt != nil && *sc.goal.ClosedAt != "" {
			entries = append(entries, ThreadEntry{At: utc(*sc.goal.ClosedAt), Kind: "goal_event", ID: fmt.Sprintf("goal:%d:%s", sc.goal.ID, sc.goal.State), Event: sc.goal.State})
		}
	}
	for _, t := range sc.tasks {
		entries = append(entries, ThreadEntry{At: utc(t.CreatedAt), Kind: "task_event", ID: fmt.Sprintf("task:%d:created", t.ID), TaskID: t.ID, Event: "created", By: t.CreatedBy})
		if t.ClaimedAt != nil && *t.ClaimedAt != "" {
			by := ""
			if t.AssignedTo != nil {
				by = *t.AssignedTo
			}
			entries = append(entries, ThreadEntry{At: utc(*t.ClaimedAt), Kind: "task_event", ID: fmt.Sprintf("task:%d:claimed", t.ID), TaskID: t.ID, Event: "claimed", By: by})
		}
		if t.CompletedAt != nil && *t.CompletedAt != "" {
			by := ""
			if t.CompletedBy != nil {
				by = *t.CompletedBy
			}
			entries = append(entries, ThreadEntry{At: utc(*t.CompletedAt), Kind: "task_event", ID: fmt.Sprintf("task:%d:%s", t.ID, t.Status), TaskID: t.ID, Event: t.Status, By: by})
		}
	}
	// questions to the Operator about the goal or its tasks
	asks, askTask, askText, capped, err := s.threadAsks(ctx, q, sc)
	if err != nil {
		return nil, err
	}
	page.Capped = page.Capped || capped
	states, err := s.askStates(ctx, q.Team, q.Operator, asks)
	if err != nil {
		return nil, err
	}
	for _, a := range asks {
		line, _ := q.cut(askText[a.MessageID], ThreadLineCap, true)
		entries = append(entries, ThreadEntry{At: utc(a.CreatedAt), Kind: "ask", ID: fmt.Sprintf("ask:%d", a.MessageID), TaskID: askTask[a.MessageID], MessageID: a.MessageID, Asker: a.Asker, Line: line, State: states[a.MessageID]})
	}
	// the agents' replies through the task route
	if len(sc.taskIDs) > 0 {
		in, args := idList(sc.taskIDs)
		var rows []struct {
			ID      int64  `db:"id"`
			From    string `db:"subscriber_id"`
			Content string `db:"content"`
			At      string `db:"created_at"`
			TaskID  int64  `db:"task_id"`
		}
		args = append([]any{q.Team}, append(args, threadSourceCap+1)...)
		if err := s.reader().SelectContext(ctx, &rows, `SELECT id, subscriber_id, content, created_at, task_id FROM board_messages WHERE project = ? AND task_id IN (`+in+`) ORDER BY id DESC LIMIT ?`, args...); err != nil {
			return nil, err
		}
		if len(rows) > threadSourceCap {
			rows, page.Capped = rows[:threadSourceCap], true
		}
		for _, r := range rows {
			text, trunc := q.cut(r.Content, ThreadTextCap, false)
			entries = append(entries, ThreadEntry{At: utc(r.At), Kind: "reply", ID: fmt.Sprintf("reply:%d", r.ID), TaskID: r.TaskID, MessageID: r.ID, From: r.From, Text: text, Truncated: trunc})
		}
	}
	// the Operator's decisions (S1: the Activity row's goal and task)
	decisions, decCapped, err := s.threadDecisions(ctx, q, sc)
	if err != nil {
		return nil, err
	}
	entries = append(entries, decisions...)
	page.Capped = page.Capped || decCapped
	// the files its tasks produced
	files, filesCapped, err := s.threadFiles(ctx, q, sc)
	if err != nil {
		return nil, err
	}
	page.Capped = page.Capped || filesCapped
	entries = append(entries, files...)

	sort.SliceStable(entries, func(i, j int) bool { return entries[i].key().less(entries[j].key()) })
	desc := q.Order == "desc"
	if desc {
		for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
			entries[i], entries[j] = entries[j], entries[i]
		}
	}
	start := 0
	if after != nil {
		start = len(entries)
		for i, e := range entries {
			k := e.key()
			if (!desc && after.less(k)) || (desc && k.less(*after)) {
				start = i
				break
			}
		}
	}
	rest := entries[start:]
	if len(rest) > limit {
		page.Entries, page.More = rest[:limit], true
		page.Cursor = encodeCursor(page.Entries[limit-1].key())
	} else {
		page.Entries = append(page.Entries, rest...)
	}
	return page, nil
}

// threadAsks reads the questions to the Operator whose subject is the goal (a goal read) or one of the tasks, with the board in the query.
func (s *Store) threadAsks(ctx context.Context, q ThreadQuery, sc *threadScope) (asks []askRow, taskOf map[int64]int64, text map[int64]string, capped bool, err error) {
	taskOf, text = map[int64]int64{}, map[int64]string{}
	var where string
	args := []any{q.Team}
	switch {
	case q.TaskID > 0:
		where, args = "s.task_id = ?", append(args, q.TaskID)
	default:
		where, args = "s.goal_id = ?", append(args, q.GoalID)
	}
	args = append(args, threadSourceCap+1)
	var rows []struct {
		askRow
		TaskID  int64  `db:"task_id"`
		Content string `db:"content"`
	}
	err = s.reader().SelectContext(ctx, &rows, `SELECT a.message_id, a.asker, a.asked, a.created_at, s.task_id, COALESCE(m.content, '') AS content
		FROM board_asks a JOIN board_ask_subjects s ON s.message_id = a.message_id AND s.project = a.project
		LEFT JOIN board_messages m ON m.id = a.message_id AND m.project = a.project
		WHERE a.project = ? AND `+where+` ORDER BY a.message_id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, nil, nil, false, err
	}
	if len(rows) > threadSourceCap {
		rows, capped = rows[:threadSourceCap], true
	}
	for _, r := range rows {
		if !askedOperator(r.askRow, q.Operator) {
			continue // not a question to the Operator: not theirs to see here
		}
		asks = append(asks, r.askRow)
		taskOf[r.MessageID], text[r.MessageID] = r.TaskID, r.Content
	}
	return asks, taskOf, text, capped, nil
}

// threadFiles lists the files the scope's tasks reference (their workflow's artifact refs), with each file's review state. Bounded by the scan the team artifact list already uses.
func (s *Store) threadFiles(ctx context.Context, q ThreadQuery, sc *threadScope) ([]ThreadEntry, bool, error) {
	if len(sc.taskIDs) == 0 {
		return nil, false, nil
	}
	tasks, truncated, err := s.ListTeamArtifactTasks(ctx, q.Team, MaxTeamArtifactTaskScan)
	if err != nil {
		return nil, false, err
	}
	want := map[int64]bool{}
	for _, id := range sc.taskIDs {
		want[id] = true
	}
	reviews, err := s.ArtifactReviews(ctx, q.Team)
	if err != nil {
		return nil, false, err
	}
	var out []ThreadEntry
	for _, t := range tasks {
		if !want[t.TaskID] {
			continue
		}
		at := t.CompletedAt
		if at == "" {
			at = t.CreatedAt
		}
		for _, a := range t.Artifacts {
			digest := strings.TrimPrefix(a.Digest, "sha256:")
			if digest == "" {
				continue // a link with no stored object has no file to show
			}
			name, _ := q.cut(a.Name, ThreadLineCap, true)
			state := "unreviewed"
			if rv, ok := reviews[digest]; ok && rv.State != "" {
				state = rv.State
			}
			out = append(out, ThreadEntry{At: utc(at), Kind: "file", ID: "file:" + digest, TaskID: t.TaskID, Digest: digest, Name: name, State: state, By: t.CompletedBy})
		}
	}
	return out, truncated, nil
}

func (s *Store) threadHeader(ctx context.Context, q ThreadQuery, sc *threadScope) ThreadHeader {
	h := ThreadHeader{Team: q.Team}
	if sc.goal != nil {
		h.GoalID, h.GoalTitle = sc.goal.ID, sc.goal.Title
	}
	if q.TaskID > 0 && len(sc.tasks) == 1 {
		h.Kind, h.TaskID, h.TaskTitle = "task", sc.tasks[0].ID, sc.tasks[0].Title
		h.Title, h.Status = sc.tasks[0].Title, sc.tasks[0].Status
		if h.GoalID == 0 && sc.tasks[0].GoalID != nil {
			h.GoalID = *sc.tasks[0].GoalID
		}
		if h.GoalTitle == "" && h.GoalID > 0 { // the task's own goal, read with the team in the query
			if g, err := s.GetGoal(ctx, q.Team, h.GoalID); err == nil && g != nil {
				h.GoalTitle = g.Title
			}
		}
		return h
	}
	h.Kind = "goal"
	if sc.goal != nil {
		h.Title, h.Status = sc.goal.Title, sc.goal.State
	}
	return h
}

// threadDecisions reads the Operator's Activity rows about the thread, by the goal and task ids saved when each was written (a row from before them is not in a thread, by design).
func (s *Store) threadDecisions(ctx context.Context, q ThreadQuery, sc *threadScope) ([]ThreadEntry, bool, error) {
	where, args := "team = ?", []any{q.Team}
	if q.TaskID > 0 {
		where, args = where+" AND task_id = ?", append(args, q.TaskID)
	} else {
		where, args = where+" AND goal_id = ?", append(args, q.GoalID)
	}
	if q.Actor != "" {
		where, args = where+" AND actor = ?", append(args, q.Actor)
	}
	args = append(args, threadSourceCap+1)
	var rows []OperatorAction
	if err := s.reader().SelectContext(ctx, &rows, `SELECT id, at, actor, action, item_kind, item_id, team, source, title, note, goal_id, task_id FROM operator_actions WHERE `+where+` ORDER BY id DESC LIMIT ?`, args...); err != nil {
		return nil, false, err
	}
	capped := false
	if len(rows) > threadSourceCap {
		rows, capped = rows[:threadSourceCap], true
	}
	out := make([]ThreadEntry, 0, len(rows))
	for _, r := range rows {
		e := ThreadEntry{At: utc(r.At), Kind: "decision", ID: "decision:" + strconv.FormatInt(r.ID, 10), Action: r.Action, Actor: r.Actor, Source: r.Source, ItemKind: r.ItemKind, ItemID: r.ItemID}
		if r.TaskID != nil {
			e.TaskID = *r.TaskID
		}
		e.Title, _ = q.cut(r.Title, ThreadLineCap, true)
		e.Note, _ = q.cut(r.Note, ThreadTextCap, false)
		if r.ItemKind == "question" {
			if n, err := strconv.ParseInt(r.ItemID, 10, 64); err == nil {
				e.AskID = n
			}
		}
		out = append(out, e)
	}
	return out, capped, nil
}
