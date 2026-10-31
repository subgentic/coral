package board

import (
	"context"
	"sort"
	"strings"
)

// WaitsOnThis is what waits on an Inbox item (#11455, for the Needs you rows of #11442): the number of open tasks held up, the one that matters most (its title), the goal it would close, and the highest
// priority among them. It is worked out here, from the board data of every board, so the browser asks nothing per team and misses no waiter on another board.
type WaitsOnThis struct {
	Count      int    `json:"count"`
	TopTitle   string `json:"top_title,omitempty"`   // the title of the waiter that matters most: the highest priority, then the lowest number
	ClosesGoal string `json:"closes_goal,omitempty"` // the goal's title, when the item's task is the last open one of its goal (a review's)
	Priority   string `json:"priority,omitempty"`    // the highest priority of the waiters: critical, high, medium or low
}

// WaitOwner is a running session whose row asks what waits on it. Key is how the caller tells it apart (its session id).
type WaitOwner struct {
	Key         string
	SessionName string // the name its board subscription is under
	SessionID   string
}

const openWaiterStatuses = `'pending','blocked','in_progress','review_pending'`

var waitPriorityRank = map[string]int{"critical": 0, "high": 1, "medium": 2, "low": 3}

type waiter struct {
	ID       int64
	Title    string
	Priority string
}

func waitRankOf(p string) int {
	if r, ok := waitPriorityRank[p]; ok {
		return r
	}
	return 2
}

func chunkInts(ids []int64, f func(marks string, args []any) error) error {
	for start := 0; start < len(ids); start += 400 {
		end := min(start+400, len(ids))
		args := make([]any, 0, end-start)
		for _, id := range ids[start:end] {
			args = append(args, id)
		}
		if err := f(strings.TrimSuffix(strings.Repeat("?,", len(args)), ","), args); err != nil {
			return err
		}
	}
	return nil
}

func chunkStrings(ss []string, f func(marks string, args []any) error) error {
	for start := 0; start < len(ss); start += 400 {
		end := min(start+400, len(ss))
		args := make([]any, 0, end-start)
		for _, v := range ss[start:end] {
			args = append(args, v)
		}
		if err := f(strings.TrimSuffix(strings.Repeat("?,", len(args)), ","), args); err != nil {
			return err
		}
	}
	return nil
}

// dependentsOf is, for each upstream task id, the open tasks (of any board) that list it as a blocker. A task is not its own dependent.
func (s *Store) dependentsOf(ctx context.Context, upstream []int64) (map[int64][]waiter, error) {
	out := map[int64][]waiter{}
	err := chunkInts(upstream, func(marks string, args []any) error {
		var rows []struct {
			Up       int64  `db:"up"`
			ID       int64  `db:"id"`
			Title    string `db:"title"`
			Priority string `db:"priority"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT td.blocked_by_task_id AS up, t.id AS id, t.title AS title, t.priority AS priority
			FROM task_dependencies td JOIN board_tasks t ON t.id = td.task_id
			WHERE td.blocked_by_task_id IN (`+marks+`) AND t.id <> td.blocked_by_task_id AND t.status IN (`+openWaiterStatuses+`)`, args...); err != nil {
			return err
		}
		for _, r := range rows {
			out[r.Up] = append(out[r.Up], waiter{ID: r.ID, Title: r.Title, Priority: r.Priority})
		}
		return nil
	})
	return out, err
}

// infoOf is what a set of waiters comes to; ok is false when none wait and no goal closes.
func infoOf(ws []waiter, closes string) (WaitsOnThis, bool) {
	if len(ws) == 0 && closes == "" {
		return WaitsOnThis{}, false
	}
	sort.Slice(ws, func(i, j int) bool {
		if ri, rj := waitRankOf(ws[i].Priority), waitRankOf(ws[j].Priority); ri != rj {
			return ri < rj
		}
		return ws[i].ID < ws[j].ID
	})
	info := WaitsOnThis{Count: len(ws), ClosesGoal: closes}
	if len(ws) > 0 {
		info.TopTitle, info.Priority = ws[0].Title, ws[0].Priority
	}
	return info, true
}

// WaitsOnSessions says, for each session that has any, what waits on it: its in-progress tasks (matched by the session that claimed them, or by the subscriber id they are assigned to on the board the
// session is subscribed to, never by a display name) and the open tasks of every board that wait on those. A session with no task in progress has nothing waiting. The map is keyed by WaitOwner.Key.
func (s *Store) WaitsOnSessions(ctx context.Context, owners []WaitOwner) (map[string]WaitsOnThis, error) {
	out := map[string]WaitsOnThis{}
	if len(owners) == 0 {
		return out, nil
	}
	byName := map[string]WaitOwner{}
	var names, sids []string
	for _, o := range owners {
		if o.SessionName != "" {
			byName[o.SessionName] = o
			names = append(names, o.SessionName)
		}
		if o.SessionID != "" {
			sids = append(sids, o.SessionID)
		}
	}
	var subs []waitSub
	if err := chunkStrings(names, func(marks string, args []any) error {
		var rows []struct {
			Name       string `db:"session_name"`
			Project    string `db:"project"`
			Subscriber string `db:"subscriber_id"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT session_name, project, subscriber_id FROM board_subscribers WHERE is_active = 1 AND session_name IN (`+marks+`)`, args...); err != nil {
			return err
		}
		for _, r := range rows {
			subs = append(subs, waitSub{r.Project, r.Subscriber, r.Name})
		}
		return nil
	}); err != nil {
		return nil, err
	}
	subIDs := make([]string, 0, len(subs))
	for _, sb := range subs {
		subIDs = append(subIDs, sb.Subscriber)
	}
	type own struct {
		ID              int64
		Board, Assigned string
		SessionID       string
		Title, Priority string
	}
	var tasks []own
	collect := func(marks string, args []any, col string) error {
		var rows []struct {
			ID       int64   `db:"id"`
			Board    string  `db:"board_id"`
			Assigned *string `db:"assigned_to"`
			Session  *string `db:"session_id"`
			Title    string  `db:"title"`
			Priority string  `db:"priority"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT id, board_id, assigned_to, session_id, title, priority FROM board_tasks WHERE status = 'in_progress' AND `+col+` IN (`+marks+`)`, args...); err != nil {
			return err
		}
		for _, r := range rows {
			t := own{ID: r.ID, Board: r.Board, Title: r.Title, Priority: r.Priority}
			if r.Assigned != nil {
				t.Assigned = *r.Assigned
			}
			if r.Session != nil {
				t.SessionID = *r.Session
			}
			tasks = append(tasks, t)
		}
		return nil
	}
	if err := chunkStrings(sids, func(marks string, args []any) error { return collect(marks, args, "session_id") }); err != nil {
		return nil, err
	}
	if err := chunkStrings(subIDs, func(marks string, args []any) error { return collect(marks, args, "assigned_to") }); err != nil {
		return nil, err
	}
	// each task is one task, however it matched
	seen := map[int64]bool{}
	mine := map[string][]own{} // owner key -> its in-progress tasks
	for _, t := range tasks {
		if seen[t.ID] {
			continue
		}
		seen[t.ID] = true
		for _, o := range owners {
			match := o.SessionID != "" && t.SessionID == o.SessionID
			if !match {
				if sb, ok := bySub(subs, byName, o); ok && t.Board == sb.Project && strings.EqualFold(t.Assigned, sb.Subscriber) {
					match = true
				}
			}
			if match {
				mine[o.Key] = append(mine[o.Key], t)
			}
		}
	}
	var ids []int64
	for _, ts := range mine {
		for _, t := range ts {
			ids = append(ids, t.ID)
		}
	}
	deps, err := s.dependentsOf(ctx, ids)
	if err != nil {
		return nil, err
	}
	for key, ts := range mine {
		byID := map[int64]waiter{}
		for _, t := range ts {
			byID[t.ID] = waiter{ID: t.ID, Title: t.Title, Priority: t.Priority} // the in-progress tasks are held up by what the session waits for
			for _, d := range deps[t.ID] {
				byID[d.ID] = d
			}
		}
		ws := make([]waiter, 0, len(byID))
		for _, w := range byID {
			ws = append(ws, w)
		}
		if info, ok := infoOf(ws, ""); ok {
			out[key] = info
		}
	}
	return out, nil
}

// waitSub is a session's board subscription: the board and the subscriber id it holds there.
type waitSub struct{ Project, Subscriber, Name string }

func bySub(subs []waitSub, byName map[string]WaitOwner, o WaitOwner) (waitSub, bool) {
	for _, sb := range subs {
		if w, ok := byName[sb.Name]; ok && w.Key == o.Key {
			return sb, true
		}
	}
	return waitSub{}, false
}

// WaitsOnTasks says, for each task id of a board that has any, what waits on it: the open tasks of every board that list it as a blocker, and the goal it would close (it is open and the last open task
// of its goal). A task with neither is not in the map.
func (s *Store) WaitsOnTasks(ctx context.Context, project string, taskIDs []int64) (map[int64]WaitsOnThis, error) {
	out := map[int64]WaitsOnThis{}
	if len(taskIDs) == 0 {
		return out, nil
	}
	deps, err := s.dependentsOf(ctx, taskIDs)
	if err != nil {
		return nil, err
	}
	type tk struct {
		ID     int64
		Status string
		GoalID int64
		Goal   string
	}
	tasks := map[int64]tk{}
	if err := chunkInts(taskIDs, func(marks string, args []any) error {
		var rows []struct {
			ID     int64   `db:"id"`
			Status string  `db:"status"`
			GoalID *int64  `db:"goal_id"`
			Goal   *string `db:"title"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT t.id AS id, t.status AS status, t.goal_id AS goal_id, g.title AS title FROM board_tasks t
			LEFT JOIN board_goals g ON g.id = t.goal_id AND g.board_id = t.board_id WHERE t.board_id = ? AND t.id IN (`+marks+`)`, append([]any{project}, args...)...); err != nil {
			return err
		}
		for _, r := range rows {
			t := tk{ID: r.ID, Status: r.Status}
			if r.GoalID != nil {
				t.GoalID = *r.GoalID
			}
			if r.Goal != nil {
				t.Goal = *r.Goal
			}
			tasks[r.ID] = t
		}
		return nil
	}); err != nil {
		return nil, err
	}
	var goalIDs []int64
	for _, t := range tasks {
		if t.GoalID > 0 && t.Goal != "" {
			goalIDs = append(goalIDs, t.GoalID)
		}
	}
	openIn := map[int64]int{} // goal -> its open tasks
	if err := chunkInts(goalIDs, func(marks string, args []any) error {
		var rows []struct {
			GoalID int64 `db:"goal_id"`
			N      int   `db:"n"`
		}
		if err := s.reader().SelectContext(ctx, &rows, `SELECT goal_id, COUNT(*) AS n FROM board_tasks WHERE board_id = ? AND status IN (`+openWaiterStatuses+`) AND goal_id IN (`+marks+`) GROUP BY goal_id`, append([]any{project}, args...)...); err != nil {
			return err
		}
		for _, r := range rows {
			openIn[r.GoalID] = r.N
		}
		return nil
	}); err != nil {
		return nil, err
	}
	for _, id := range taskIDs {
		t, found := tasks[id]
		closes := ""
		if found && t.GoalID > 0 && t.Goal != "" && openIn[t.GoalID] == 1 && isOpenStatus(t.Status) {
			closes = t.Goal
		}
		if info, ok := infoOf(append([]waiter(nil), deps[id]...), closes); ok {
			out[id] = info
		}
	}
	return out, nil
}

func isOpenStatus(s string) bool {
	switch s {
	case "pending", "blocked", "in_progress", "review_pending":
		return true
	}
	return false
}
