package board

import (
	"context"
	"strings"
)

// ForeignSeat is a board seat held by a session that was launched on another board (#11112): before #11013 an agent could seat itself, or an agent it started, on another team's board, and those seats stay until
// the Operator removes them. The session's live row says where it was launched.
type ForeignSeat struct {
	BoardID          string `json:"board_id"`
	BoardLabel       string `json:"board_label"`
	SubscriberID     string `json:"subscriber_id"`
	JobTitle         string `json:"job_title"`
	SessionName      string `json:"session_name"`
	SessionID        string `json:"session_id"`
	AgentName        string `json:"agent_name"`
	LaunchBoard      string `json:"launch_board"`
	LaunchBoardLabel string `json:"launch_board_label"`
	SubscribedAt     string `json:"subscribed_at"`
}

// ForeignSeats are the active seats of live sessions whose launch board (their live row's board_name) is another board than the seat's. The Operator's own seats (no session), a session with no live row any more and
// one launched on no board are not listed: nothing says they are somewhere they do not belong. Empty without the sessions database.
func (s *Store) ForeignSeats(ctx context.Context) ([]ForeignSeat, error) {
	if s.sessionsDB == nil {
		return []ForeignSeat{}, nil
	}
	var sessions []struct {
		SessionID string  `db:"session_id"`
		AgentName string  `db:"agent_name"`
		BoardName *string `db:"board_name"`
	}
	if err := s.sessionsDB.SelectContext(ctx, &sessions, `SELECT session_id, agent_name, board_name FROM live_sessions WHERE board_name IS NOT NULL AND board_name != ''`); err != nil {
		return nil, err
	}
	launch := make(map[string]struct{ board, agent string }, len(sessions))
	for _, ls := range sessions {
		launch[ls.SessionID] = struct{ board, agent string }{*ls.BoardName, ls.AgentName}
	}
	var seats []struct {
		Project      string  `db:"project"`
		SubscriberID string  `db:"subscriber_id"`
		JobTitle     string  `db:"job_title"`
		SessionName  *string `db:"session_name"`
		SubscribedAt string  `db:"subscribed_at"`
	}
	if err := s.reader().SelectContext(ctx, &seats, `SELECT project, subscriber_id, COALESCE(job_title, '') AS job_title, session_name, subscribed_at FROM board_subscribers WHERE is_active = 1 AND session_name IS NOT NULL AND session_name != '' ORDER BY project, subscribed_at, id`); err != nil {
		return nil, err
	}
	out := []ForeignSeat{}
	labels := map[string]string{}
	label := func(key string) string {
		if l, ok := labels[key]; ok {
			return l
		}
		l := key
		if b, err := s.GetBoard(ctx, key); err == nil && b != nil && b.Label != "" {
			l = b.Label
		}
		labels[key] = l
		return l
	}
	for _, seat := range seats {
		name := *seat.SessionName
		i := strings.Index(name, "-")
		if i < 0 {
			continue
		}
		sid := name[i+1:]
		l, ok := launch[sid]
		if !ok || l.board == seat.Project {
			continue
		}
		out = append(out, ForeignSeat{
			BoardID: seat.Project, BoardLabel: label(seat.Project), SubscriberID: seat.SubscriberID, JobTitle: seat.JobTitle, SessionName: name, SessionID: sid,
			AgentName: l.agent, LaunchBoard: l.board, LaunchBoardLabel: label(l.board), SubscribedAt: seat.SubscribedAt,
		})
	}
	return out, nil
}
