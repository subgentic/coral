package board

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// The Hub's service-only per-machine read (#7364, the #7331 note sections 6, 11 point 4 and 12, frozen in #7411): which tasks of this computer came from ONE goal request, and nothing else. It is bound
// to the request, not to a goal uid: the request must be one that THIS asker (the server and board it was sent from) sent and this computer accepted, and the rows are the tasks made by accepting it
// (board_tasks.request_id with the sender's server and board, written only by AcceptGoalRequest). A task labelled with a goal uid any other way, another asker's request and a request that is
// pending, declined or expired show nothing, and a request nobody sent shows nothing too (an empty answer, the same as for one that was not accepted: the read does not say which).

const (
	// GoalLinksDefaultLimit and GoalLinksMaxLimit are the rows of a page when the caller says none, and the most it may ask for.
	GoalLinksDefaultLimit = 50
	GoalLinksMaxLimit     = 100
	// GoalLinksMaxCursor is the longest cursor this read gives or takes, in bytes.
	GoalLinksMaxCursor = 128
	// GoalLinksTitleMax and GoalLinksAssigneeMax bound the two free-text fields of a row, in characters.
	GoalLinksTitleMax    = 200
	GoalLinksAssigneeMax = 128
	// The same two fields are also cut to a byte bound (four bytes a character is the worst), so a full page of the largest rows stays under GoalLinksReplyMaxBytes whatever the text.
	GoalLinksTitleBytes    = 512
	GoalLinksAssigneeBytes = 256
	// GoalLinksReplyMaxBytes is the one byte cap of a whole reply (the routes test holds a full page of the largest rows under it).
	GoalLinksReplyMaxBytes = 128 << 10
)

// ErrBadGoalLinksQuery is a cursor that is not one this server gave for this request and asker.
var ErrBadGoalLinksQuery = errors.New("bad goal links query")

// ErrGoalRequestsOff is the receiving board's switch for goal requests being off: the Hub is told so by name (409), and only about a request this asker really sent.
var ErrGoalRequestsOff = errors.New("goal requests are off on the receiving board")

// GoalLinkRow is one accepted request, as the Hub shows it: the request, the board and goal it was for, the task made, and when it was accepted. Title is redacted and bounded.
type GoalLinkRow struct {
	RequestID    string `json:"request_id"`
	Board        string `json:"board"`
	GoalUID      string `json:"goal_uid"`
	TaskID       int64  `json:"task_id"`
	TaskStatus   string `json:"task_status"`
	RequestState string `json:"request_state"`
	AcceptedAt   string `json:"accepted_at"`
	Title        string `json:"title"`
	Assignee     string `json:"assignee"`
	UpdatedAt    string `json:"updated_at"`
}

// GoalLinkReply is the whole answer: the request asked about, a page of its accepted rows, their exact count, and the cursor of the next page (null on the last).
type GoalLinkReply struct {
	RequestID     string        `json:"request_id"`
	Accepted      []GoalLinkRow `json:"accepted_requests"`
	AcceptedTotal int           `json:"accepted_requests_total"`
	NextCursor    *string       `json:"next_cursor"`
}

// goalLinksKey is what a cursor is bound to: the request, and the asker it is for, as a short hash (a board name may hold any character, so none is spelled in the cursor).
func goalLinksKey(requestID, server, boardID string) string {
	sum := sha256.Sum256([]byte(requestID + "\x00" + server + "\x00" + boardID))
	return hex.EncodeToString(sum[:8])
}

// rfc3339UTC writes a stored timestamp as RFC3339 in UTC; one that does not parse is returned as stored.
func rfc3339UTC(s string) string {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return s
}

// boundText cuts s to at most n characters and at most nBytes bytes, on a character boundary.
func boundText(s string, n, nBytes int) string {
	if utf8.RuneCountInString(s) > n {
		s = string([]rune(s)[:n])
	}
	for len(s) > nBytes {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	return s
}

// GoalLinks is the page of the requests this asker (server, boardID) sent as requestID that this computer accepted, with the task made for each. limit is 1..GoalLinksMaxLimit (the caller checks it); redact,
// when given, cleans each title. A cursor that was not made for this request and asker is ErrBadGoalLinksQuery; a request this asker sent whose receiving board has goal requests off is ErrGoalRequestsOff.
func (s *Store) GoalLinks(ctx context.Context, requestID, server, boardID, cursor string, limit int, redact func(string) string) (*GoalLinkReply, error) {
	if !ValidGoalRequestID(requestID) || limit < 1 || limit > GoalLinksMaxLimit {
		return nil, ErrBadGoalLinksQuery
	}
	key := goalLinksKey(requestID, server, boardID)
	var afterAt string
	var afterID int64
	if cursor != "" {
		if len(cursor) > GoalLinksMaxCursor {
			return nil, ErrBadGoalLinksQuery
		}
		at, id, err := decodeTaskCursor(cursor, key, "l")
		if err != nil {
			return nil, ErrBadGoalLinksQuery
		}
		if _, perr := time.Parse(time.RFC3339Nano, at); perr != nil {
			return nil, ErrBadGoalLinksQuery
		}
		afterAt, afterID = at, id
	}
	// The switch is only ever asked about this asker's own request (no existence oracle for anyone else's): a row the asker sent, on a board whose goal_requests setting is not "true".
	var off int
	if err := s.reader().GetContext(ctx, &off, `SELECT COUNT(*) FROM board_goal_requests_in r
		WHERE r.request_id = ? AND r.from_server = ? AND r.from_board = ?
		  AND COALESCE((SELECT value FROM board_settings WHERE project = r.board_id AND key = ?), 'false') != 'true'`, requestID, server, boardID, settingGoalRequests); err != nil {
		return nil, err
	}
	if off > 0 {
		return nil, ErrGoalRequestsOff
	}
	const from = ` FROM board_goal_requests_in r JOIN board_tasks t ON t.id = r.task_id AND t.board_id = r.board_id AND t.request_id = r.request_id
		AND t.request_server = r.from_server AND t.request_board = r.from_board
		WHERE r.request_id = ? AND r.from_server = ? AND r.from_board = ? AND r.status = 'accepted'`
	reply := &GoalLinkReply{RequestID: requestID, Accepted: []GoalLinkRow{}}
	if err := s.reader().GetContext(ctx, &reply.AcceptedTotal, `SELECT COUNT(*)`+from, requestID, server, boardID); err != nil {
		return nil, err
	}
	// Stable order (accepted_at, task_id); answered_at is stored in one fixed UTC format, so the text order is the time order.
	var rows []struct {
		Board      string `db:"board_id"`
		GoalUID    string `db:"goal_uid"`
		TaskID     int64  `db:"task_id"`
		TaskStatus string `db:"status"`
		AcceptedAt string `db:"accepted_at"`
		Title      string `db:"title"`
		Assignee   string `db:"assignee"`
		UpdatedAt  string `db:"updated_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT r.board_id, r.goal_uid, t.id AS task_id, t.status, COALESCE(r.answered_at, r.created_at) AS accepted_at, t.title,
		COALESCE(t.assigned_to, '') AS assignee, `+strings.ReplaceAll(updatedAtSQL, "created_at", "t.created_at")+` AS updated_at`+from+`
		AND (COALESCE(r.answered_at, r.created_at) > ? OR (COALESCE(r.answered_at, r.created_at) = ? AND t.id > ?))
		ORDER BY accepted_at ASC, t.id ASC LIMIT ?`, requestID, server, boardID, afterAt, afterAt, afterID, limit+1); err != nil {
		return nil, err
	}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		c := encodeTaskCursor(key, "l", last.AcceptedAt, last.TaskID)
		reply.NextCursor = &c
	}
	for _, r := range rows {
		// Redact the WHOLE title first, then cut: cutting first could leave the front of a secret that straddles the bound, which no rule would then recognise (#7464).
		title := r.Title
		if redact != nil {
			title = redact(title)
		}
		title = boundText(title, GoalLinksTitleMax, GoalLinksTitleBytes)
		reply.Accepted = append(reply.Accepted, GoalLinkRow{
			RequestID: requestID, Board: r.Board, GoalUID: r.GoalUID, TaskID: r.TaskID, TaskStatus: r.TaskStatus, RequestState: GoalRequestAccepted,
			AcceptedAt: rfc3339UTC(r.AcceptedAt), Title: title, Assignee: boundText(r.Assignee, GoalLinksAssigneeMax, GoalLinksAssigneeBytes), UpdatedAt: rfc3339UTC(r.UpdatedAt),
		})
	}
	return reply, nil
}
