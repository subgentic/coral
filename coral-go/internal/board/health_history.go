package board

import (
	"context"
	"regexp"
	"strconv"
	"time"
)

// What each member's own history says (#11729 slice 3): how long its tasks take, how often it posts on one, how long a wait on a given party takes to be answered. Read-only, scoped to the board.

// historyPerAgent is how many of an agent's latest finished tasks are its history.
const historyPerAgent = 30

// historyScan bounds how many finished tasks are read to build every agent's history.
const historyScan = 3000

// ClaimToDoneDurations is, per agent (who completed the task, else who it was assigned to), the claimed-to-completed times of its latest finished tasks, newest first, at most historyPerAgent each.
func (s *Store) ClaimToDoneDurations(ctx context.Context, project string) (map[string][]time.Duration, error) {
	var rows []struct {
		Agent     string `db:"agent"`
		ClaimedAt string `db:"claimed_at"`
		DoneAt    string `db:"completed_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT COALESCE(completed_by, assigned_to) AS agent, claimed_at, completed_at FROM board_tasks
		WHERE board_id = ? AND status = 'completed' AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND COALESCE(completed_by, assigned_to) IS NOT NULL
		ORDER BY completed_at DESC LIMIT ?`, project, historyScan); err != nil {
		return nil, err
	}
	out := map[string][]time.Duration{}
	for _, r := range rows {
		if len(out[r.Agent]) >= historyPerAgent {
			continue
		}
		c, err1 := time.Parse(time.RFC3339, r.ClaimedAt)
		d, err2 := time.Parse(time.RFC3339, r.DoneAt)
		if err1 != nil || err2 != nil || d.Before(c) {
			continue
		}
		out[r.Agent] = append(out[r.Agent], d.Sub(c))
	}
	return out, nil
}

// TaskPostTimes are the times, oldest first, of the posts by a member that name the task (#N, not as the start of a longer number) since since: what it said on the task.
func (s *Store) TaskPostTimes(ctx context.Context, project, subscriberID string, taskID int64, since time.Time) ([]time.Time, error) {
	var rows []struct {
		Content string `db:"content"`
		At      string `db:"created_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT content, created_at FROM board_messages WHERE project = ? AND subscriber_id = ? AND created_at >= ? AND COALESCE(is_system, 0) = 0
		AND content LIKE ? ORDER BY id LIMIT 500`, project, subscriberID, since.UTC().Format(time.RFC3339), "%#"+strconv.FormatInt(taskID, 10)+"%"); err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`#` + strconv.FormatInt(taskID, 10) + `\b`)
	var out []time.Time
	for _, r := range rows {
		if !re.MatchString(r.Content) {
			continue
		}
		if at, err := time.Parse(time.RFC3339, r.At); err == nil {
			out = append(out, at)
		}
	}
	return out, nil
}

// ResolvedWaitDurations is how long the member's earlier waits of the same kind on the same target took to be answered (the resolved ones, newest first, at most limit); an expired or cancelled wait
// was not answered and is not counted.
func (s *Store) ResolvedWaitDurations(ctx context.Context, project, subscriberID, waitType, targetID string, limit int) ([]time.Duration, error) {
	var rows []struct {
		Created  string  `db:"created_at"`
		Resolved *string `db:"resolved_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT created_at, resolved_at FROM board_waits WHERE project = ? AND subscriber_id = ? AND wait_type = ? AND target_id = ?
		AND status = 'resolved' AND resolved_at IS NOT NULL ORDER BY id DESC LIMIT ?`, project, subscriberID, waitType, targetID, limit); err != nil {
		return nil, err
	}
	var out []time.Duration
	for _, r := range rows {
		c, err1 := time.Parse(time.RFC3339, r.Created)
		d, err2 := time.Parse(time.RFC3339, *r.Resolved)
		if err1 == nil && err2 == nil && !d.Before(c) {
			out = append(out, d.Sub(c))
		}
	}
	return out, nil
}
