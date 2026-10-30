package board

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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
	// FollowUpsOpen: the open tasks of the goal that were made as follow-ups of another task (task add --follow-up); filled where one goal is read (GetGoal), never in a list.
	FollowUpsOpen int `db:"-" json:"follow_ups_open,omitempty"`
}

// Closed reports whether the goal is done or dropped.
func (g Goal) Closed() bool { return g.State == GoalDone || g.State == GoalDropped }

// goalColumns are the columns of a Goal.
const goalColumns = `id, goal_uid, board_id, title, outcome, done_when, state, blocked_on, driver, created_by, created_at, updated_at, closed_at, closed_reason`

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
	now := nowUTC()
	res, err := s.execEnsuringBoard(ctx, board, `INSERT INTO board_goals (goal_uid, board_id, title, outcome, done_when, state, driver, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
	if g.FollowUpsOpen, err = s.goalFollowUpsOpen(ctx, board, id); err != nil {
		return nil, err
	}
	return &g, nil
}

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

// inheritedGoal is the goal a retry of task retryOf continues under: the retried task's own, when it has one and that goal is still open.
func (s *Store) inheritedGoal(ctx context.Context, board string, retryOf int64) *int64 {
	var id sql.NullInt64
	if err := s.db.GetContext(ctx, &id, `SELECT t.goal_id FROM board_tasks t JOIN board_goals g ON g.id = t.goal_id AND g.board_id = t.board_id AND g.state NOT IN ('done', 'dropped') WHERE t.id = ? AND t.board_id = ?`, retryOf, board); err != nil || !id.Valid {
		return nil
	}
	return &id.Int64
}

// goalSummary is what the feed carries for a board (no text): how many goals are open (proposed, active or blocked) and the board's change counter, which moves on every goal write and every
// task change that touches a goal. A board with no goals reads 0 and 0.
func (s *Store) goalSummary(ctx context.Context, board string) (open int, seq int64, err error) {
	err = s.reader().QueryRowxContext(ctx, `SELECT
		(SELECT COUNT(*) FROM board_goals WHERE board_id = ?1 AND state IN ('proposed', 'active', 'blocked')),
		COALESCE((SELECT seq FROM board_goal_meta WHERE board_id = ?1), 0)`, board).Scan(&open, &seq)
	return open, seq, err
}

// GoalRef is the goal a task or an agent serves, as a row shows it (#7301).
type GoalRef struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
	Board string `json:"board"`
}

// GoalsOfSessions gives, for each of the sessions, the goal of its in-progress task when that task has a goal (the newest claim wins when it has several); a session with no such task is not in the map.
// One read for the whole list, in chunks.
func (s *Store) GoalsOfSessions(ctx context.Context, sessionIDs []string) (map[string]GoalRef, error) {
	out := map[string]GoalRef{}
	for start := 0; start < len(sessionIDs); start += 400 {
		end := min(start+400, len(sessionIDs))
		chunk := sessionIDs[start:end]
		marks := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		var rows []struct {
			SessionID string `db:"session_id"`
			GoalID    int64  `db:"goal_id"`
			Title     string `db:"title"`
			Board     string `db:"board_id"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT t.session_id AS session_id, g.id AS goal_id, g.title AS title, g.board_id AS board_id
			FROM board_tasks t JOIN board_goals g ON g.id = t.goal_id AND g.board_id = t.board_id
			WHERE t.status = 'in_progress' AND t.session_id IN (`+marks+`)
			ORDER BY t.claimed_at ASC, t.id ASC`, args...); err != nil {
			return nil, err
		}
		for _, r := range rows { // oldest first: the newest claim overwrites
			out[r.SessionID] = GoalRef{ID: r.GoalID, Title: r.Title, Board: r.Board}
		}
	}
	return out, nil
}

// FillGoalTitles sets GoalTitle on every task that has a goal, from one read of the goals' titles (a goal of the task's own board only).
func (s *Store) FillGoalTitles(ctx context.Context, tasks []Task) error {
	ids := map[int64]bool{}
	for i := range tasks {
		if tasks[i].GoalID != nil {
			ids[*tasks[i].GoalID] = true
		}
	}
	if len(ids) == 0 {
		return nil
	}
	list := make([]int64, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	type key struct {
		board string
		id    int64
	}
	titles := map[key]string{}
	for start := 0; start < len(list); start += 400 {
		end := min(start+400, len(list))
		chunk := list[start:end]
		marks := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		var rows []struct {
			ID    int64  `db:"id"`
			Board string `db:"board_id"`
			Title string `db:"title"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT id, board_id, title FROM board_goals WHERE id IN (`+marks+`)`, args...); err != nil {
			return err
		}
		for _, r := range rows {
			titles[key{r.Board, r.ID}] = r.Title
		}
	}
	for i := range tasks {
		if tasks[i].GoalID != nil {
			tasks[i].GoalTitle = titles[key{tasks[i].BoardID, *tasks[i].GoalID}]
		}
	}
	return nil
}
