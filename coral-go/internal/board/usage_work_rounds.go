package board

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// UsageWindow names a task's recorded work round. No match is inferred from an
// agent name: restarted agents and simultaneous sessions must stay separate.
type UsageWindow struct {
	TaskID                             int64
	Session, Board, GoalKey, GoalLabel string
	Claimed, Ended                     time.Time
}

func (s *Store) UsageWindows(ctx context.Context) ([]UsageWindow, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT t.id, t.board_id, t.session_id, COALESCE(t.goal_id,0), COALESCE(g.title,''),
 COALESCE(t.claimed_at,''), CASE WHEN t.status='in_progress' THEN '' ELSE COALESCE(NULLIF(w.eff_submitted,''),t.completed_at,t.claimed_at,'') END, COALESCE(NULLIF(t.work_windows,''),'[]')
 FROM board_tasks t LEFT JOIN board_goals g ON g.id=t.goal_id AND g.board_id=t.board_id
 LEFT JOIN task_workflows w ON w.task_id=t.id WHERE COALESCE(t.session_id,'')<>''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageWindow{}
	for rows.Next() {
		var w UsageWindow
		var goal int64
		var claimed, ended, prior string
		if err := rows.Scan(&w.TaskID, &w.Board, &w.Session, &goal, &w.GoalLabel, &claimed, &ended, &prior); err != nil {
			return nil, err
		}
		w.GoalKey = "no-goal"
		if goal > 0 {
			w.GoalKey = fmt.Sprintf("%s/%d", w.Board, goal)
			if w.GoalLabel == "" {
				w.GoalLabel = fmt.Sprintf("Goal %d", goal)
			}
		} else {
			w.GoalLabel = "Tasks with no goal"
		}
		var rounds [][2]string
		if err := json.Unmarshal([]byte(prior), &rounds); err != nil {
			return nil, fmt.Errorf("task %d work windows: %w", w.TaskID, err)
		}
		rounds = append(rounds, [2]string{claimed, ended})
		for _, round := range rounds {
			start, err := time.Parse(time.RFC3339Nano, round[0])
			if err != nil {
				continue
			}
			finish := time.Time{}
			if round[1] != "" {
				finish, err = time.Parse(time.RFC3339Nano, round[1])
				if err != nil {
					continue
				}
			}
			if !finish.IsZero() && !finish.After(start) {
				continue
			}
			w.Claimed, w.Ended = start, finish
			out = append(out, w)
		}
	}
	return out, rows.Err()
}
