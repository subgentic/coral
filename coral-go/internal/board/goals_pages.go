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
)

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
	// Seq is the board's goals change counter (the one the live feed's goals_brief carries), on a board's own list: it moves on every goal write and every task change that touches a goal, so a caller that
	// remembers the last one knows whether anything changed (#7296). Absent on the all-boards read.
	Seq int64 `json:"seq,omitempty"`
	// NoGoalOpen is how many of the board's open tasks (pending, in progress, blocked, draft, in review) serve no goal: the same number on every page of a listing and under every state filter, 0 for a board
	// with no tasks (#7292). It is a pointer so the machine-wide read (AllGoalsPage, GET /api/goals) leaves it out instead of answering 0 for every board together.
	NoGoalOpen *int `json:"no_goal_open,omitempty"`
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
	var seq int64
	if err := s.reader().GetContext(ctx, &seq, `SELECT seq FROM board_goal_meta WHERE board_id = ?`, board); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	noGoal, err := s.noGoalOpenTasks(ctx, board)
	if err != nil {
		return nil, err
	}
	return &GoalPage{Goals: goals, NextCursor: next, Seq: seq, NoGoalOpen: &noGoal}, nil
}

// noGoalOpenTasks counts the board's open tasks that link to no goal: one count over idx_board_tasks_board_status.
func (s *Store) noGoalOpenTasks(ctx context.Context, board string) (int, error) {
	marks := strings.TrimSuffix(strings.Repeat("?,", len(openTaskStatuses)), ",")
	args := []any{board}
	for _, st := range openTaskStatuses {
		args = append(args, st)
	}
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND status IN (`+marks+`) AND goal_id IS NULL`, args...)
	return n, err
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
	s.loadListVerification(ctx, page.Tasks)
	fillListReviewers(page.Tasks)
	s.fillListArtifactCounts(ctx, page.Tasks)
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
