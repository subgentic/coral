package board

import (
	"context"
	"sort"
	"time"
)

// Messages per agent and task (#11225, for the Analytics tabs of #11222): how many messages an agent sent and received while it had a task in progress, within its team and across teams, with
// Coral's own notices counted apart. Derived from the board's own tables (tasks: assigned_to, claimed_at, completed_at; messages: author, time, @mentions), so nothing is recorded for it and no text is
// kept or returned (a message is read only to find who it @mentions). Bounded like BoardActivity: a window of at most MaxActivityDays and MaxActivityRows messages and tasks.

// MaxTaskMessageRows bounds the rows one read returns (an agent-task pair each).
const MaxTaskMessageRows = 500

// TaskMessages is one agent's message counts for one task, over the part of the task's time in progress that falls in the window.
type TaskMessages struct {
	TaskID    int64  `json:"task_id"`
	Agent     string `json:"agent"`
	Sent      int    `json:"sent"`      // agent-written messages the agent posted while it had the task
	Received  int    `json:"received"`  // agent-written messages that @mention the agent while it had the task
	Within    int    `json:"within"`    // of Sent and Received, those that stayed on this team's board
	Across    int    `json:"across"`    // of Sent and Received, those that came from or went to another team
	Automated int    `json:"automated"` // Coral's own notices (Task Queue, Health Monitor, the other automated senders) that named the agent while it had the task, kept apart from the rest
}

// TaskMessageCounts counts, for each task assigned to an agent and claimed in [since, until), the messages the agent sent and received while the task was in progress (claimed_at up to completed_at, or the
// end of the window). Rows are ordered by task, at most MaxTaskMessageRows.
func (s *Store) TaskMessageCounts(ctx context.Context, project, since, until string) ([]TaskMessages, bool, error) {
	st, err1 := time.Parse(time.RFC3339, since)
	en, err2 := time.Parse(time.RFC3339, until)
	if err1 != nil || err2 != nil || !en.After(st) || en.Sub(st) > MaxActivityDays*24*time.Hour {
		return nil, false, ErrBadActivityWindow
	}
	var tasks []struct {
		ID          int64   `db:"id"`
		AssignedTo  string  `db:"assigned_to"`
		ClaimedAt   string  `db:"claimed_at"`
		CompletedAt *string `db:"completed_at"`
	}
	if err := s.reader().SelectContext(ctx, &tasks, `SELECT id, assigned_to, claimed_at, completed_at FROM board_tasks
		WHERE board_id = ? AND assigned_to IS NOT NULL AND assigned_to != '' AND claimed_at IS NOT NULL AND substr(claimed_at, 1, 10) <= ? AND (completed_at IS NULL OR substr(completed_at, 1, 10) >= ?)
		ORDER BY id LIMIT ?`, project, en.Format("2006-01-02"), st.Format("2006-01-02"), MaxActivityRows+1); err != nil {
		return nil, false, err
	}
	truncated := false
	if len(tasks) > MaxActivityRows {
		tasks, truncated = tasks[:MaxActivityRows], true
	}
	if len(tasks) == 0 {
		return []TaskMessages{}, truncated, nil
	}
	var titles []struct {
		ID    string  `db:"subscriber_id"`
		Title *string `db:"job_title"`
	}
	if err := s.reader().SelectContext(ctx, &titles, `SELECT subscriber_id, job_title FROM board_subscribers WHERE project = ? AND subscriber_id IS NOT NULL`, project); err != nil {
		return nil, false, err
	}
	nameOf := map[string]string{}
	var names []string
	seen := map[string]bool{}
	for _, t := range titles {
		n := t.ID
		if t.Title != nil && *t.Title != "" {
			n = *t.Title
		}
		nameOf[t.ID] = n
		if !seen[n] && !IsOperatorName(n) && !isAutomatedSender(n) && len(n) >= 2 {
			seen[n] = true
			names = append(names, n)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return len(names[i]) > len(names[j]) || (len(names[i]) == len(names[j]) && names[i] < names[j])
	})
	// each assignee's task windows, clipped to the read window
	type window struct {
		row        *TaskMessages
		start, end time.Time
	}
	byAgent := map[string][]window{}
	rows := make([]*TaskMessages, 0, len(tasks))
	for _, t := range tasks {
		name := nameOf[t.AssignedTo]
		if name == "" {
			name = t.AssignedTo
		}
		// Times are compared as times, not as strings: the board stores them in more than one shape (Z, a fractional second, an offset), and a string comparison put a message of the same second as a
		// claim on the wrong side of it (QA's #11225 INFO).
		start, ok := parseBoardTime(t.ClaimedAt)
		if !ok {
			continue
		}
		end := en
		if t.CompletedAt != nil {
			if done, ok := parseBoardTime(*t.CompletedAt); ok && done.Before(end) {
				end = done
			}
		}
		if start.Before(st) {
			start = st
		}
		if !end.After(start) {
			continue
		}
		row := &TaskMessages{TaskID: t.ID, Agent: name}
		rows = append(rows, row)
		byAgent[name] = append(byAgent[name], window{row, start, end})
	}
	if len(rows) == 0 {
		return []TaskMessages{}, truncated, nil
	}
	var msgs []activityMsg
	if err := s.reader().SelectContext(ctx, &msgs, `SELECT m.id, COALESCE(m.subscriber_id, '') AS subscriber_id, s.job_title, m.content, m.created_at, m.is_system, m.origin, m.external_json
		FROM board_messages m LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
		WHERE m.project = ? AND substr(m.created_at, 1, 10) >= ? AND substr(m.created_at, 1, 10) <= ? ORDER BY m.id LIMIT ?`, project, st.Format("2006-01-02"), en.Format("2006-01-02"), MaxActivityRows+1); err != nil {
		return nil, false, err
	}
	if len(msgs) > MaxActivityRows {
		msgs, truncated = msgs[:MaxActivityRows], true
	}
	for _, m := range msgs {
		at, ok := parseBoardTime(m.CreatedAt)
		if !ok || at.Before(st) || !at.Before(en) {
			continue
		}
		name := m.Sender
		if m.Title != nil && *m.Title != "" {
			name = *m.Title
		}
		cross := m.External != nil && *m.External != ""
		automated := !cross && (m.IsSystem || (m.Origin != nil && *m.Origin == OriginHubNotice) || isAutomatedSender(m.Sender))
		operator := !cross && !automated && (IsOperatorName(m.Sender) || (m.Origin != nil && *m.Origin == OriginHubOperator))
		if operator {
			continue // the Operator's posts belong to the operator tab
		}
		if !automated {
			// sent: the author's own tasks in progress at the time
			for _, w := range byAgent[name] {
				if !at.Before(w.start) && at.Before(w.end) {
					w.row.Sent++
					if cross {
						w.row.Across++
					} else {
						w.row.Within++
					}
				}
			}
		}
		for _, to := range mentionedNames(m.Content, names) {
			if to == name && !automated {
				continue
			}
			for _, w := range byAgent[to] {
				if at.Before(w.start) || !at.Before(w.end) {
					continue
				}
				switch {
				case automated:
					w.row.Automated++
				default:
					w.row.Received++
					if cross {
						w.row.Across++
					} else {
						w.row.Within++
					}
				}
			}
		}
	}
	out := make([]TaskMessages, 0, len(rows))
	for _, r := range rows {
		if r.Sent+r.Received+r.Automated > 0 {
			out = append(out, *r)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TaskID != out[j].TaskID {
			return out[i].TaskID < out[j].TaskID
		}
		return out[i].Agent < out[j].Agent
	})
	if len(out) > MaxTaskMessageRows {
		out, truncated = out[:MaxTaskMessageRows], true
	}
	return out, truncated, nil
}

// parseBoardTime reads a time the board stored, in any of the shapes it stores them in.
func parseBoardTime(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}
