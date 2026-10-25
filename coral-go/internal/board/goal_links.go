package board

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// The Hub's service-only per-machine read (#7364, the #7331 note sections 6, 11 point 4 and 12): which tasks of this computer came from ONE goal request, and nothing else. It is bound to the request, not
// to a goal uid: the request must be one that THIS asker (the server and board it was sent from) sent and this computer accepted, and the rows are the tasks made by accepting it (board_tasks.request_id,
// written only by AcceptGoalRequest). A task labelled with a goal uid any other way, another asker's request and a request that is pending, declined or expired show nothing, and a request nobody sent
// shows nothing too (an empty page, the same as for one that was not accepted: the read does not say which).

// GoalLinksPageSize is the rows of a page: 50, fixed (the read takes no limit).
const GoalLinksPageSize = 50

// ErrBadGoalLinksQuery is a cursor that is not one this server gave for this request and asker.
var ErrBadGoalLinksQuery = errors.New("bad goal links query")

// GoalLink is one row of the read: a task made for the request, as the Hub shows it. No body, no goal and no request id: ids, a title (redacted), the task's status, its assignee, when it last changed and
// its board.
type GoalLink struct {
	ID        int64  `db:"id" json:"id"`
	Title     string `db:"title" json:"title"`
	State     string `db:"status" json:"state"`
	Assignee  string `db:"assignee" json:"assignee"`
	UpdatedAt string `db:"updated_at" json:"updated_at"`
	Board     string `db:"board_id" json:"board"`
}

// GoalLinkPage is a page of links, oldest task first; Next is empty on the last page.
type GoalLinkPage struct {
	Links []GoalLink `json:"links"`
	Next  string     `json:"next_cursor,omitempty"`
}

// goalLinksKey is what a cursor is bound to: the request, and the asker it is for, as a short hash (a request id or board name may hold any character, so none is spelled in the cursor).
func goalLinksKey(requestID, server, boardID string) string {
	sum := sha256.Sum256([]byte(requestID + "\x00" + server + "\x00" + boardID))
	return hex.EncodeToString(sum[:8])
}

// GoalLinks is the page of the tasks made by accepting request requestID, when the asker (server, boardID) sent it and this computer accepted it. redact, when given, cleans each title. A cursor that was
// not made for this request and asker is ErrBadGoalLinksQuery.
func (s *Store) GoalLinks(ctx context.Context, requestID, server, boardID, cursor string, redact func(string) string) (*GoalLinkPage, error) {
	key := goalLinksKey(requestID, server, boardID)
	var after int64
	if cursor != "" {
		forKey, id, err := decodeTaskCursor(cursor, "-", "l")
		if err != nil || forKey != key {
			return nil, ErrBadGoalLinksQuery
		}
		after = id
	}
	page := &GoalLinkPage{Links: []GoalLink{}}
	if err := s.reader().SelectContext(ctx, &page.Links, `SELECT id, title, status, COALESCE(assigned_to, '') AS assignee, `+updatedAtSQL+` AS updated_at, board_id
		FROM board_tasks
		WHERE request_id = ? AND id > ? AND EXISTS (SELECT 1 FROM board_goal_requests_in r WHERE r.request_id = board_tasks.request_id AND r.board_id = board_tasks.board_id
			AND r.from_server = ? AND r.from_board = ? AND r.status = 'accepted')
		ORDER BY id ASC LIMIT ?`, requestID, after, server, boardID, GoalLinksPageSize+1); err != nil {
		return nil, err
	}
	if len(page.Links) > GoalLinksPageSize {
		page.Links = page.Links[:GoalLinksPageSize]
		page.Next = encodeTaskCursor("-", "l", key, page.Links[GoalLinksPageSize-1].ID)
	}
	if redact != nil {
		for i := range page.Links {
			page.Links[i].Title = redact(page.Links[i].Title)
		}
	}
	return page, nil
}
