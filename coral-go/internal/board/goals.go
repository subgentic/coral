package board

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/subgentic/coral/internal/clitext"
)

// Goals on the board (#7087, from #7078's note and coral-hub's revision): an outcome a board's tasks work toward. A goal is its own row, not a kind of task, so no reader of board_tasks changes
// its meaning; a task links to at most one goal of its own board (board_tasks.goal_id). A goal's rollup counts only its own board's tasks, always. Nothing here starts, wakes or messages
// anything: a goal write is board text.
//
// Naming: a session's "goal line" (background/goals.go) is another thing; this is the board goal.

// The states of a goal. Done and dropped close it (CloseGoal); the others are kept true by UpdateGoal.
const (
	GoalProposed = "proposed"
	GoalActive   = "active"
	GoalBlocked  = "blocked"
	GoalDone     = "done"
	GoalDropped  = "dropped"
)

// The longest each piece of goal text may be, in characters. A longer one is refused, never cut.
const (
	MaxGoalTitle     = 200
	MaxGoalOutcome   = 2000
	MaxGoalDoneWhen  = 300
	MaxGoalBlockedOn = 200
	MaxGoalDriver    = 200
	MaxGoalReason    = 300
)

// GoalError is a refusal with a fixed word: the handler maps Code to the status, the CLI shows Message. Compare with errors.Is against the values below.
type GoalError struct {
	Code    string
	Message string
}

func (e *GoalError) Error() string { return e.Message }

// The refusals. An unknown goal, another board's goal and a deleted one are all ErrGoalNotFound, so a caller learns nothing about goals of other boards.
var (
	ErrGoalNotFound          = &GoalError{"goal_not_found", "no such goal on this board"}
	ErrGoalTitleRequired     = &GoalError{"goal_title_required", "a goal needs a title"}
	ErrGoalTextTooLong       = &GoalError{"goal_text_too_long", "goal text is too long"}
	ErrGoalBadState          = &GoalError{"goal_bad_state", "a goal's state is proposed, active, blocked, done or dropped"}
	ErrGoalBlockedOnRequired = &GoalError{"goal_blocked_on_required", "a blocked goal says who or what it waits for (--blocked-on)"}
	ErrGoalReasonRequired    = &GoalError{"goal_reason_required", "closing a goal needs a one-line reason"}
	ErrGoalClosed            = &GoalError{"goal_closed", "this goal is closed (done or dropped): reopen it with goal update --state active before adding tasks"}
	ErrGoalNotClosed         = &GoalError{"goal_not_closed", "this goal is not closed"}
	ErrGoalAlreadyClosed     = &GoalError{"goal_already_closed", "this goal is already closed"}
	ErrGoalTaskNotFound      = &GoalError{"task_not_found", "no such task on this board"}
	ErrGoalDriverUnknown     = &GoalError{"goal_driver_unknown", "the driver is not a subscriber of this board"}
)

// textTooLong is ErrGoalTextTooLong naming the field and its limit.
func textTooLong(field string, max int) error {
	return &GoalError{Code: ErrGoalTextTooLong.Code, Message: fmt.Sprintf("goal %s is too long (at most %d characters)", field, max)}
}

func (e *GoalError) Is(target error) bool {
	t, ok := target.(*GoalError)
	return ok && t.Code == e.Code
}

// GoalRollup counts a goal's tasks by what they are doing.
type GoalRollup struct {
	Done    int `json:"done"`    // completed, skipped
	Active  int `json:"active"`  // in progress, waiting for review
	Blocked int `json:"blocked"` // blocked
	Queued  int `json:"queued"`  // pending, draft
	Total   int `json:"total"`
}

// Goal is one row of board_goals.
type Goal struct {
	ID        int64  `db:"id" json:"id"`
	UID       string `db:"goal_uid" json:"goal_uid"`
	BoardID   string `db:"board_id" json:"board_id"`
	Title     string `db:"title" json:"title"`
	Outcome   string `db:"outcome" json:"outcome"`
	DoneWhen  string `db:"done_when" json:"done_when"`
	State     string `db:"state" json:"state"`
	BlockedOn string `db:"blocked_on" json:"blocked_on,omitempty"`
	// Driver is the board subscriber who drives the goal; "" for none. A blocked goal says why in blocked_on, a plain reason: a goal does not wait on a person (a task or an agent does).
	Driver       string     `db:"driver" json:"driver,omitempty"`
	CreatedBy    string     `db:"created_by" json:"created_by"`
	CreatedAt    string     `db:"created_at" json:"created_at"`
	UpdatedAt    string     `db:"updated_at" json:"updated_at"`
	ClosedAt     *string    `db:"closed_at" json:"closed_at,omitempty"`
	ClosedReason string     `db:"closed_reason" json:"closed_reason,omitempty"`
	Rollup       GoalRollup `db:"-" json:"rollup"`
}

// Closed reports whether the goal is done or dropped.
func (g Goal) Closed() bool { return g.State == GoalDone || g.State == GoalDropped }

// goalColumns are the columns of a Goal.
const goalColumns = `id, goal_uid, board_id, title, outcome, done_when, state, blocked_on, driver, created_by, created_at, updated_at, closed_at, closed_reason`

func (s *Store) ensureGoalsSchema(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS board_goals (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			goal_uid      TEXT NOT NULL,
			board_id      TEXT NOT NULL,
			title         TEXT NOT NULL,
			outcome       TEXT NOT NULL DEFAULT '',
			done_when     TEXT NOT NULL DEFAULT '',
			state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('proposed', 'active', 'blocked', 'done', 'dropped')),
			blocked_on    TEXT NOT NULL DEFAULT '',
			driver        TEXT NOT NULL DEFAULT '',
			created_by    TEXT NOT NULL DEFAULT '',
			created_at    TEXT NOT NULL,
			updated_at    TEXT NOT NULL,
			closed_at     TEXT,
			closed_reason TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_board_goals_uid ON board_goals(goal_uid)`,
		`CREATE INDEX IF NOT EXISTS idx_board_goals_board ON board_goals(board_id, state, id)`,
		// A goal's uid is set at creation and never changes: a reference that outlives re-enrolling and board re-keys is made of it.
		`CREATE TRIGGER IF NOT EXISTS board_goals_uid_immutable BEFORE UPDATE OF goal_uid ON board_goals WHEN OLD.goal_uid IS NOT NEW.goal_uid
			BEGIN SELECT RAISE(ABORT, 'a goal uid is never changed'); END`,
		// The per-board change counter the feed's goals summary carries: one row per board, moved by the database itself on every goal write and every task change that touches a goal, so no
		// writer of board_tasks can forget it (the triggers are the census).
		`CREATE TABLE IF NOT EXISTS board_goal_meta (
			board_id   TEXT PRIMARY KEY,
			seq        INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	for _, ddl := range []string{"ALTER TABLE board_tasks ADD COLUMN goal_id INTEGER", "ALTER TABLE boards ADD COLUMN board_uid TEXT"} {
		if _, err := s.db.ExecContext(ctx, ddl); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	// The goal decision fields (decision, recommendation, if_silent) and the answer are gone (#7300, the Operator's decision: a goal does not wait on a person): a database that has the columns drops them, after the
	// trigger that watches them, which is made again below without them.
	if _, err := s.db.ExecContext(ctx, `DROP TRIGGER IF EXISTS board_goals_seq_update`); err != nil {
		return err
	}
	for _, col := range []string{"decision", "recommendation", "if_silent", "answer"} {
		if _, err := s.db.ExecContext(ctx, "ALTER TABLE board_goals DROP COLUMN "+col); err != nil && !strings.Contains(err.Error(), "no such column") {
			return err
		}
	}
	const bump = `INSERT INTO board_goal_meta (board_id, seq, updated_at) VALUES (%s, 1, strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ', 'now'))
		ON CONFLICT(board_id) DO UPDATE SET seq = seq + 1, updated_at = excluded.updated_at;`
	for _, stmt := range []string{
		`CREATE INDEX IF NOT EXISTS idx_board_tasks_goal ON board_tasks(board_id, goal_id) WHERE goal_id IS NOT NULL`,
		// A board's own uid (boards.board_uid) is set by CreateBoard only, is unique where there is one, and is never changed once set: no backfill (a board made before it has none).
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_board_uid ON boards(board_uid) WHERE board_uid IS NOT NULL`,
		`CREATE TRIGGER IF NOT EXISTS boards_board_uid_immutable BEFORE UPDATE OF board_uid ON boards WHEN OLD.board_uid IS NOT NULL AND NEW.board_uid IS NOT OLD.board_uid
			BEGIN SELECT RAISE(ABORT, 'a board uid is never changed'); END`,
		`CREATE TRIGGER IF NOT EXISTS board_goals_seq_insert AFTER INSERT ON board_goals BEGIN ` + fmt.Sprintf(bump, "NEW.board_id") + ` END`,
		// The update triggers fire only when a column they watch really changes (#7239): an UPDATE that writes the same values is not a change, and an open Goals view refreshes on this counter. They are dropped
		// and made again so a database that has the older, unguarded ones gets these.
		`DROP TRIGGER IF EXISTS board_goals_seq_update`,
		`CREATE TRIGGER board_goals_seq_update AFTER UPDATE OF title, outcome, done_when, state, blocked_on, driver, closed_at, closed_reason ON board_goals
			WHEN OLD.title IS NOT NEW.title OR OLD.outcome IS NOT NEW.outcome OR OLD.done_when IS NOT NEW.done_when OR OLD.state IS NOT NEW.state OR OLD.blocked_on IS NOT NEW.blocked_on OR OLD.driver IS NOT NEW.driver
			OR OLD.closed_at IS NOT NEW.closed_at OR OLD.closed_reason IS NOT NEW.closed_reason
			BEGIN ` + fmt.Sprintf(bump, "NEW.board_id") + ` END`,
		`CREATE TRIGGER IF NOT EXISTS board_goals_seq_delete AFTER DELETE ON board_goals BEGIN ` + fmt.Sprintf(bump, "OLD.board_id") + ` END`,
		`CREATE TRIGGER IF NOT EXISTS board_tasks_goal_seq_insert AFTER INSERT ON board_tasks WHEN NEW.goal_id IS NOT NULL BEGIN ` + fmt.Sprintf(bump, "NEW.board_id") + ` END`,
		`DROP TRIGGER IF EXISTS board_tasks_goal_seq_update`,
		`CREATE TRIGGER board_tasks_goal_seq_update AFTER UPDATE OF status, goal_id ON board_tasks WHEN (OLD.goal_id IS NOT NULL OR NEW.goal_id IS NOT NULL) AND (OLD.status IS NOT NEW.status OR OLD.goal_id IS NOT NEW.goal_id) BEGIN ` + fmt.Sprintf(bump, "NEW.board_id") + ` END`,
		`CREATE TRIGGER IF NOT EXISTS board_tasks_goal_seq_delete AFTER DELETE ON board_tasks WHEN OLD.goal_id IS NOT NULL BEGIN ` + fmt.Sprintf(bump, "OLD.board_id") + ` END`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// goalLine cleans one line of goal text (no control, bidi or zero-width character, white space as one space) and refuses one longer than max characters.
func goalLine(field, s string, max int) (string, error) {
	s = clitext.CleanName(s)
	if utf8.RuneCountInString(s) > max {
		return "", textTooLong(field, max)
	}
	return s, nil
}

// goalText is goalLine for the outcome, which may have several lines.
func goalText(field, s string, max int) (string, error) {
	s = strings.TrimSpace(clitext.Clean(s))
	if utf8.RuneCountInString(s) > max {
		return "", textTooLong(field, max)
	}
	return s, nil
}

// GoalInput is a new goal.
type GoalInput struct {
	Title, Outcome, DoneWhen string
	// State is proposed or active (the default): a goal is made, not closed or blocked.
	State     string
	CreatedBy string
	// Driver is a subscriber of the board who drives the goal; empty for none.
	Driver string
}

// CreateGoal makes a goal on a board. The board is recorded if nothing has used it yet.
func (s *Store) CreateGoal(ctx context.Context, board string, in GoalInput) (*Goal, error) {
	if board == "" {
		return nil, errors.New("a goal needs a board")
	}
	title, err := goalLine("title", in.Title, MaxGoalTitle)
	if err != nil {
		return nil, err
	}
	if title == "" {
		return nil, ErrGoalTitleRequired
	}
	outcome, err := goalText("outcome", in.Outcome, MaxGoalOutcome)
	if err != nil {
		return nil, err
	}
	doneWhen, err := goalLine("done_when", in.DoneWhen, MaxGoalDoneWhen)
	if err != nil {
		return nil, err
	}
	state := in.State
	if state == "" {
		state = GoalActive
	}
	if state != GoalActive && state != GoalProposed {
		return nil, ErrGoalBadState
	}
	createdBy, err := goalLine("created_by", in.CreatedBy, 200)
	if err != nil {
		return nil, err
	}
	driver, err := s.checkDriver(ctx, s.db, board, in.Driver)
	if err != nil {
		return nil, err
	}
	s.ensureBoardRow(ctx, board)
	now := nowUTC()
	res, err := s.db.ExecContext(ctx, `INSERT INTO board_goals (goal_uid, board_id, title, outcome, done_when, state, driver, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), board, title, outcome, doneWhen, state, driver, createdBy, now, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetGoal(ctx, board, id)
}

// goalQuerier is what a read of a goal needs: the store's connection, or the transaction a write holds (the board database has one writer connection, so a read through the store inside a
// transaction would wait for the transaction it is part of).
type goalQuerier interface {
	GetContext(ctx context.Context, dest any, query string, args ...any) error
}

// checkDriver cleans a driver's name and says it is a subscriber of the board; "" is no driver.
func (s *Store) checkDriver(ctx context.Context, q goalQuerier, board, name string) (string, error) {
	name, err := goalLine("driver", name, MaxGoalDriver)
	if err != nil || name == "" {
		return "", err
	}
	var n int
	if err := q.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_subscribers WHERE project = ? AND subscriber_id = ?`, board, name); err != nil {
		return "", err
	}
	if n == 0 {
		return "", ErrGoalDriverUnknown
	}
	return name, nil
}

// GetGoal is the goal with this id on this board, with its rollup. Another board's goal is not found.
func (s *Store) GetGoal(ctx context.Context, board string, id int64) (*Goal, error) {
	var g Goal
	err := s.reader().GetContext(ctx, &g, `SELECT `+goalColumns+` FROM board_goals WHERE id = ? AND board_id = ?`, id, board)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrGoalNotFound
	}
	if err != nil {
		return nil, err
	}
	rollups, err := s.goalRollups(ctx, board, []int64{id})
	if err != nil {
		return nil, err
	}
	g.Rollup = rollups[id]
	return &g, nil
}

// GoalListQuery selects goals. States empty means every goal that is not closed (proposed, active, blocked); a state name selects exactly those named. Limit is the task list's: 0 is its default (50),
// above its maximum (200) is clamped. Cursor is the NextCursor of the page before.
type GoalListQuery struct {
	States []string
	Limit  int
	Cursor string
}

// GoalPage is one page of a board's goals, oldest first (by id): NextCursor continues it, "" on the last page.
type GoalPage struct {
	Goals      []Goal `json:"goals"`
	NextCursor string `json:"next_cursor"`
}

// goalStatesKey is the filter a goal cursor is bound to: the states asked for, each once, in a fixed order, so a cursor made for one filter is refused under another (#7239).
func goalStatesKey(states []string) string {
	seen := map[string]bool{}
	var out []string
	for _, st := range states {
		if !seen[st] {
			seen[st] = true
			out = append(out, st)
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// GoalPage is a page of a board's goals, each with its rollup. A cursor of another board, another filter or another read is ErrBadTaskListQuery.
func (s *Store) GoalPage(ctx context.Context, board string, q GoalListQuery) (*GoalPage, error) {
	states := q.States
	if len(states) == 0 {
		states = []string{GoalProposed, GoalActive, GoalBlocked}
	}
	for _, st := range states {
		if !validGoalState(st) {
			return nil, ErrGoalBadState
		}
	}
	key := goalStatesKey(states)
	limit := q.Limit
	if limit <= 0 {
		limit = TaskListDefaultLimit
	}
	if limit > TaskListMaxLimit {
		limit = TaskListMaxLimit
	}
	args := []any{board}
	marks := make([]string, 0, len(states))
	for _, st := range states {
		marks = append(marks, "?")
		args = append(args, st)
	}
	where := `board_id = ? AND state IN (` + strings.Join(marks, ",") + `)`
	if q.Cursor != "" {
		at, after, err := decodeTaskCursor(q.Cursor, board, "G")
		if err != nil {
			return nil, err
		}
		if at != key {
			return nil, fmt.Errorf("%w: cursor is for another state filter", ErrBadTaskListQuery)
		}
		where += ` AND id > ?`
		args = append(args, after)
	}
	args = append(args, limit+1)
	goals := []Goal{}
	if err := s.reader().SelectContext(ctx, &goals, `SELECT `+goalColumns+` FROM board_goals WHERE `+where+` ORDER BY id ASC LIMIT ?`, args...); err != nil {
		return nil, err
	}
	next := ""
	if len(goals) > limit {
		goals = goals[:limit]
		next = encodeTaskCursor(board, "G", key, goals[limit-1].ID)
	}
	ids := make([]int64, len(goals))
	for i := range goals {
		ids[i] = goals[i].ID
	}
	rollups, err := s.goalRollups(ctx, board, ids)
	if err != nil {
		return nil, err
	}
	for i := range goals {
		goals[i].Rollup = rollups[goals[i].ID]
	}
	return &GoalPage{Goals: goals, NextCursor: next}, nil
}

// AllGoalsQuery selects goals across boards (#7260): States as GoalListQuery's, Boards narrows to the boards named (none: every board), Limit and Cursor as the board's own.
type AllGoalsQuery struct {
	States []string
	Boards []string
	Limit  int
	Cursor string
}

// AllGoalsMaxBoards is the most boards one all-boards goal read may name.
const AllGoalsMaxBoards = 20

// AllGoalsDefaultLimit and AllGoalsMaxLimit bound a page of the all-boards read: a goal row can hold about 4 KB of text, so 100 goals stay under half a megabyte (Security's #7246 point 6).
const (
	AllGoalsDefaultLimit = 50
	AllGoalsMaxLimit     = 100
)

// allGoalsKey is the filter an all-boards goal cursor is bound to: the states and the boards asked for, as a short hash (a board name may hold any character, so it is not spelled in the cursor).
func allGoalsKey(states, boards []string) string {
	b := append([]string(nil), boards...)
	sort.Strings(b)
	sum := sha256.Sum256([]byte(goalStatesKey(states) + "\x00" + strings.Join(b, "\x00")))
	return hex.EncodeToString(sum[:8])
}

// AllGoalsPage is a page of the goals of every board (or the boards named), oldest first by id, each with its board and its rollup: the rollups of the whole page come from one grouped read. A cursor
// of a board's own read, of another filter or of nothing this server gave is ErrBadTaskListQuery.
func (s *Store) AllGoalsPage(ctx context.Context, q AllGoalsQuery) (*GoalPage, error) {
	states := q.States
	if len(states) == 0 {
		states = []string{GoalProposed, GoalActive, GoalBlocked}
	}
	for _, st := range states {
		if !validGoalState(st) {
			return nil, ErrGoalBadState
		}
	}
	key := allGoalsKey(states, q.Boards)
	limit := q.Limit
	if limit <= 0 {
		limit = AllGoalsDefaultLimit
	}
	if limit > AllGoalsMaxLimit {
		limit = AllGoalsMaxLimit
	}
	var args []any
	marks := make([]string, len(states))
	for i, st := range states {
		marks[i] = "?"
		args = append(args, st)
	}
	where := `state IN (` + strings.Join(marks, ",") + `)`
	if len(q.Boards) > 0 {
		where += ` AND board_id IN (` + placeholders(len(q.Boards)) + `)`
		for _, b := range q.Boards {
			args = append(args, b)
		}
	}
	if q.Cursor != "" {
		at, after, err := decodeTaskCursor(q.Cursor, allBoardsTag, "A")
		if err != nil {
			return nil, err
		}
		if at != key {
			return nil, fmt.Errorf("%w: cursor is for another filter", ErrBadTaskListQuery)
		}
		where += ` AND id > ?`
		args = append(args, after)
	}
	args = append(args, limit+1)
	goals := []Goal{}
	if err := s.reader().SelectContext(ctx, &goals, `SELECT `+goalColumns+` FROM board_goals WHERE `+where+` ORDER BY id ASC LIMIT ?`, args...); err != nil {
		return nil, err
	}
	next := ""
	if len(goals) > limit {
		goals = goals[:limit]
		next = encodeTaskCursor(allBoardsTag, "A", key, goals[limit-1].ID)
	}
	rollups, err := s.goalRollupsByID(ctx, goals)
	if err != nil {
		return nil, err
	}
	for i := range goals {
		goals[i].Rollup = rollups[goals[i].ID]
	}
	return &GoalPage{Goals: goals, NextCursor: next}, nil
}

// allBoardsTag stands for "every board" where a cursor names its board.
const allBoardsTag = "*"

// ListGoals is the first page of a board's goals (GoalPage without a cursor), for a caller that wants the goals and not the paging.
func (s *Store) ListGoals(ctx context.Context, board string, q GoalListQuery) ([]Goal, error) {
	page, err := s.GoalPage(ctx, board, q)
	if err != nil {
		return nil, err
	}
	return page.Goals, nil
}

func validGoalState(st string) bool {
	switch st {
	case GoalProposed, GoalActive, GoalBlocked, GoalDone, GoalDropped:
		return true
	}
	return false
}

// goalRollupsByID is goalRollups for goals of different boards: one grouped read over the tasks linked to the page's goals, on the (board_id, goal_id) index (idx_board_tasks_goal leads with the board:
// a goal_id list alone would scan every task, Security's #7246 point 4).
func (s *Store) goalRollupsByID(ctx context.Context, goals []Goal) (map[int64]GoalRollup, error) {
	out := make(map[int64]GoalRollup, len(goals))
	if len(goals) == 0 {
		return out, nil
	}
	query, args := goalRollupsStatement(goals)
	var rows []struct {
		GoalID int64  `db:"goal_id"`
		Status string `db:"status"`
		N      int    `db:"n"`
	}
	if err := s.reader().SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for _, r := range rows {
		ru := out[r.GoalID]
		switch r.Status {
		case "completed", "skipped":
			ru.Done += r.N
		case "in_progress", "review_pending":
			ru.Active += r.N
		case "blocked":
			ru.Blocked += r.N
		default: // pending, draft
			ru.Queued += r.N
		}
		ru.Total += r.N
		out[r.GoalID] = ru
	}
	return out, nil
}

// goalRollupsStatement is the grouped read of the tasks linked to goals: the page's boards and goal ids, both in the WHERE so the index on (board_id, goal_id) serves it.
func goalRollupsStatement(goals []Goal) (string, []any) {
	var boards []any
	seen := map[string]bool{}
	for _, g := range goals {
		if !seen[g.BoardID] {
			seen[g.BoardID] = true
			boards = append(boards, g.BoardID)
		}
	}
	args := append([]any(nil), boards...)
	for _, g := range goals {
		args = append(args, g.ID)
	}
	return `SELECT goal_id, status, COUNT(*) AS n FROM board_tasks WHERE board_id IN (` + placeholders(len(boards)) + `) AND goal_id IN (` + placeholders(len(goals)) + `) GROUP BY goal_id, status`, args
}

// goalRollups counts the tasks of each of the goals, in one query over the board's linked tasks.
func (s *Store) goalRollups(ctx context.Context, board string, ids []int64) (map[int64]GoalRollup, error) {
	out := make(map[int64]GoalRollup, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct {
		GoalID int64  `db:"goal_id"`
		Status string `db:"status"`
		N      int    `db:"n"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT goal_id, status, COUNT(*) AS n FROM board_tasks WHERE board_id = ? AND goal_id IS NOT NULL GROUP BY goal_id, status`, board); err != nil {
		return nil, err
	}
	want := make(map[int64]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	for _, r := range rows {
		if !want[r.GoalID] {
			continue
		}
		ru := out[r.GoalID]
		switch r.Status {
		case "completed", "skipped":
			ru.Done += r.N
		case "in_progress", "review_pending":
			ru.Active += r.N
		case "blocked":
			ru.Blocked += r.N
		default: // pending, draft
			ru.Queued += r.N
		}
		ru.Total += r.N
		out[r.GoalID] = ru
	}
	return out, nil
}

// GoalUpdate changes the fields that are set. A state of done or dropped is not set here: CloseGoal records the reason.
type GoalUpdate struct {
	Title, Outcome, DoneWhen, State, BlockedOn *string
	// Driver: a subscriber of the board, or "" for none.
	Driver *string
}

// UpdateGoal changes a goal's text or state: keeping it true (active, proposed, blocked on someone) and reopening a closed one. Moving a goal to blocked needs blocked_on; moving it
// anywhere else clears it. The goal is read, changed and written in one transaction, so two writers changing different fields of one goal at the same moment (the orchestrator sets the state
// while the Operator or the Hub edits the title) both keep their change (#7087, Backend's review: 188 of 200 concurrent pairs lost one before).
func (s *Store) UpdateGoal(ctx context.Context, board string, id int64, u GoalUpdate) (*Goal, error) {
	// What does not depend on the goal's own row is checked first, outside the transaction.
	var (
		title, outcome, doneWhen, blockedOn string
		err                                 error
	)
	if u.Title != nil {
		if title, err = goalLine("title", *u.Title, MaxGoalTitle); err != nil {
			return nil, err
		}
		if title == "" {
			return nil, ErrGoalTitleRequired
		}
	}
	if u.Outcome != nil {
		if outcome, err = goalText("outcome", *u.Outcome, MaxGoalOutcome); err != nil {
			return nil, err
		}
	}
	if u.DoneWhen != nil {
		if doneWhen, err = goalLine("done_when", *u.DoneWhen, MaxGoalDoneWhen); err != nil {
			return nil, err
		}
	}
	if u.BlockedOn != nil {
		if blockedOn, err = goalLine("blocked_on", *u.BlockedOn, MaxGoalBlockedOn); err != nil {
			return nil, err
		}
	}
	if u.State != nil {
		switch *u.State {
		case GoalProposed, GoalActive, GoalBlocked:
		case GoalDone, GoalDropped:
			return nil, ErrGoalReasonRequired // closing is CloseGoal, with its reason
		default:
			return nil, ErrGoalBadState
		}
	}

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var g Goal
	if err := tx.GetContext(ctx, &g, `SELECT `+goalColumns+` FROM board_goals WHERE id = ? AND board_id = ?`, id, board); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrGoalNotFound
	} else if err != nil {
		return nil, err
	}
	before := g
	if u.Title != nil {
		g.Title = title
	}
	if u.Outcome != nil {
		g.Outcome = outcome
	}
	if u.DoneWhen != nil {
		g.DoneWhen = doneWhen
	}
	if u.BlockedOn != nil {
		g.BlockedOn = blockedOn
	}
	if u.Driver != nil {
		if g.Driver, err = s.checkDriver(ctx, tx, board, *u.Driver); err != nil {
			return nil, err
		}
	}
	if u.State != nil {
		if g.Closed() {
			g.ClosedAt, g.ClosedReason = nil, ""
		}
		g.State = *u.State
	}
	if g.State != GoalBlocked {
		g.BlockedOn = ""
	} else if g.BlockedOn == "" {
		return nil, ErrGoalBlockedOnRequired
	}
	// A write that changes nothing (the same title, an empty body) is not a change: no new updated_at, and the board's change counter does not move (#7239).
	if !sameGoalText(before, g) {
		if _, err := tx.ExecContext(ctx, `UPDATE board_goals SET title = ?, outcome = ?, done_when = ?, state = ?, blocked_on = ?, driver = ?, closed_at = ?, closed_reason = ?, updated_at = ? WHERE id = ? AND board_id = ?`,
			g.Title, g.Outcome, g.DoneWhen, g.State, g.BlockedOn, g.Driver, g.ClosedAt, g.ClosedReason, nowUTC(), id, board); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetGoal(ctx, board, id)
}

// sameGoalText reports whether two reads of a goal hold the same text and state: every column UpdateGoal writes except updated_at.
func sameGoalText(a, b Goal) bool {
	closedA, closedB := "", ""
	if a.ClosedAt != nil {
		closedA = *a.ClosedAt
	}
	if b.ClosedAt != nil {
		closedB = *b.ClosedAt
	}
	return a.Title == b.Title && a.Outcome == b.Outcome && a.DoneWhen == b.DoneWhen && a.State == b.State && a.BlockedOn == b.BlockedOn && a.Driver == b.Driver && (a.ClosedAt == nil) == (b.ClosedAt == nil) && closedA == closedB && a.ClosedReason == b.ClosedReason
}

// openTaskStatuses are the task states that count as open when a goal is closed.
var openTaskStatuses = []string{"pending", "in_progress", "blocked", "draft", "review_pending"}

// CloseGoal closes a goal as done (the default) or dropped, with the one-line reason that is required. It does not refuse a goal that still has open tasks: it says how many (openTasks), so
// the caller can warn, as coral-hub's defaults ask; the tasks stay as they are. The close is one UPDATE that only an open goal matches, so of two concurrent closes one wins and the other is
// told the goal is already closed (it overwrote the first's reason and time before).
func (s *Store) CloseGoal(ctx context.Context, board string, id int64, reason, state string) (g *Goal, openTasks int, err error) {
	if state == "" {
		state = GoalDone
	}
	if state != GoalDone && state != GoalDropped {
		return nil, 0, ErrGoalBadState
	}
	reason, err = goalLine("closing reason", reason, MaxGoalReason)
	if err != nil {
		return nil, 0, err
	}
	if reason == "" {
		return nil, 0, ErrGoalReasonRequired
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	now := nowUTC()
	res, err := tx.ExecContext(ctx, `UPDATE board_goals SET state = ?, blocked_on = '', closed_at = ?, closed_reason = ?, updated_at = ?
		WHERE id = ? AND board_id = ? AND state NOT IN ('done', 'dropped')`, state, now, reason, now, id, board)
	if err != nil {
		return nil, 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var exists int
		if err := tx.GetContext(ctx, &exists, `SELECT COUNT(*) FROM board_goals WHERE id = ? AND board_id = ?`, id, board); err != nil {
			return nil, 0, err
		}
		if exists == 0 {
			return nil, 0, ErrGoalNotFound
		}
		return nil, 0, ErrGoalAlreadyClosed
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(openTaskStatuses)), ",")
	args := []any{board, id}
	for _, st := range openTaskStatuses {
		args = append(args, st)
	}
	if err := tx.GetContext(ctx, &openTasks, `SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND goal_id = ? AND status IN (`+marks+`)`, args...); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	g, err = s.GetGoal(ctx, board, id)
	return g, openTasks, err
}

// SetTaskGoal links a task to a goal of its own board, or unlinks it (goalID nil). A goal of another board, an unknown one and a closed one are refused (the first two as not found). The
// checks and the link are one transaction, so a goal closed at the same moment is not linked to.
func (s *Store) SetTaskGoal(ctx context.Context, board string, taskID int64, goalID *int64) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.GetContext(ctx, &exists, `SELECT COUNT(*) FROM board_tasks WHERE id = ? AND board_id = ?`, taskID, board); err != nil {
		return err
	}
	if exists == 0 {
		return ErrGoalTaskNotFound
	}
	if goalID != nil {
		if err := s.checkGoalForTask(ctx, tx, board, *goalID); err != nil {
			return err
		}
	} else if on, err := s.requiresGoal(ctx, tx, board); err != nil {
		return err
	} else if on {
		return ErrGoalRequired // a board that requires a goal never moves a task to none (#7116)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE board_tasks SET goal_id = ? WHERE id = ? AND board_id = ?`, goalID, taskID, board); err != nil {
		return err
	}
	return tx.Commit()
}

// checkGoalForTask is nil when a task of this board may be linked to goal id: it is on the board and not closed.
func (s *Store) checkGoalForTask(ctx context.Context, q goalQuerier, board string, id int64) error {
	var state string
	err := q.GetContext(ctx, &state, `SELECT state FROM board_goals WHERE id = ? AND board_id = ?`, id, board)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrGoalNotFound
	}
	if err != nil {
		return err
	}
	if state == GoalDone || state == GoalDropped {
		return ErrGoalClosed
	}
	return nil
}

// GoalTaskPage is a page of a goal's tasks as list rows (oldest first), for the board of the goal: status is the task list's (open, completed or all; "" is all), limit as the task list's (0 is its
// default, clamped to its maximum), cursor from the NextCursor of the page before. The totals are the goal's, whatever the status. A goal of another board is not found; a cursor of another board,
// goal, status or read, and an unknown status, are ErrBadTaskListQuery.
func (s *Store) GoalTaskPage(ctx context.Context, board string, goalID int64, status, cursor string, limit int) (*TaskListPage, error) {
	if _, err := s.GetGoal(ctx, board, goalID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = TaskListDefaultLimit
	}
	if limit > TaskListMaxLimit {
		limit = TaskListMaxLimit
	}
	where, args := `t.board_id = ? AND t.goal_id = ?`, []any{board, goalID}
	switch status {
	case "", TaskListAll:
		status = TaskListAll
	case TaskListOpen:
		where += ` AND t.` + openTaskStatusSQL
	case TaskListCompleted:
		where += ` AND t.` + doneTaskStatusSQL
	default:
		return nil, fmt.Errorf("%w: unknown status %q (use open, completed or all)", ErrBadTaskListQuery, status)
	}
	key := strconv.FormatInt(goalID, 10) + ":" + status // what a cursor is bound to
	if cursor != "" {
		forKey, after, err := decodeTaskCursor(cursor, board, "g")
		if err != nil {
			return nil, err
		}
		if forKey != key { // the cursor holds the goal and the status it was issued for: another's would skip this read's rows
			return nil, fmt.Errorf("%w: cursor is for another goal or status", ErrBadTaskListQuery)
		}
		where += ` AND t.id > ?`
		args = append(args, after)
	}
	page := &TaskListPage{Tasks: []TaskListItem{}}
	if err := s.reader().SelectContext(ctx, &page.Tasks, `SELECT `+taskListColumns+` WHERE `+where+` ORDER BY t.id ASC LIMIT ?`, append(args, limit+1)...); err != nil {
		return nil, err
	}
	if len(page.Tasks) > limit {
		page.Tasks = page.Tasks[:limit]
		page.NextCursor = encodeTaskCursor(board, "g", key, page.Tasks[limit-1].ID)
	}
	if err := s.loadListBlockedBy(ctx, page.Tasks); err != nil {
		return nil, err
	}
	if err := s.reader().QueryRowxContext(ctx, `SELECT
		 COALESCE(SUM(CASE WHEN `+openTaskStatusSQL+` THEN 1 ELSE 0 END), 0),
		 COALESCE(SUM(CASE WHEN `+doneTaskStatusSQL+` THEN 1 ELSE 0 END), 0)
		 FROM board_tasks WHERE board_id = ? AND goal_id = ?`, board, goalID).Scan(&page.TotalOpen, &page.TotalCompleted); err != nil {
		return nil, err
	}
	return page, nil
}

// inheritedGoal is the goal a retry of task retryOf continues under: the retried task's own, when it has one and that goal is still open.
func (s *Store) inheritedGoal(ctx context.Context, board string, retryOf int64) *int64 {
	var id sql.NullInt64
	if err := s.db.GetContext(ctx, &id, `SELECT t.goal_id FROM board_tasks t JOIN board_goals g ON g.id = t.goal_id AND g.board_id = t.board_id AND g.state NOT IN ('done', 'dropped') WHERE t.id = ? AND t.board_id = ?`, retryOf, board); err != nil || !id.Valid {
		return nil
	}
	return &id.Int64
}

// GoalSummary is what the feed carries for a board (no text): how many goals are open (proposed, active or blocked) and the board's change counter, which moves on every goal write and every
// task change that touches a goal. A board with no goals reads 0 and 0.
func (s *Store) GoalSummary(ctx context.Context, board string) (open int, seq int64, err error) {
	err = s.reader().QueryRowxContext(ctx, `SELECT
		(SELECT COUNT(*) FROM board_goals WHERE board_id = ?1 AND state IN ('proposed', 'active', 'blocked')),
		COALESCE((SELECT seq FROM board_goal_meta WHERE board_id = ?1), 0)`, board).Scan(&open, &seq)
	return open, seq, err
}
