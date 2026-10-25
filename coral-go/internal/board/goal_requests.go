package board

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
)

// Goal requests (#7361, the approved #7331 note): a team asks another team to create a task for one of its goals. The asker's own row (board_goal_requests_out) says only that a request
// exists and where it went, its status and the reason a decline gave: never a task, a count or a title of the other team's work. The receiver's row (board_goal_requests_in) holds the
// request's text until its Orchestrator accepts, which creates a task already linked to the goal, or declines. Both rows are the same machine's here; nothing in this file knows a Hub.

const (
	// Limits of a request's text (characters), and of a decline's reason.
	GoalRequestTitleMax  = 200
	GoalRequestAskMax    = 2000
	GoalRequestReasonMax = 500
	// Caps on the requests waiting on one board: per (sender server, sender board), in all, and per sender server (the note's section 11 point 6).
	GoalRequestPendingPerPair   = 20
	GoalRequestPendingPerTarget = 100
	GoalRequestPendingPerServer = 50
	// GoalRequestTTL is how long a request may wait for an answer.
	GoalRequestTTL = 14 * 24 * time.Hour
	// GoalRequestAcceptedListMax is how many accepted requests a goal's read lists.
	GoalRequestAcceptedListMax = 20

	GoalRequestRequested = "requested" // asker's side
	GoalRequestPending   = "pending"   // receiver's side
	GoalRequestAccepted  = "accepted"
	GoalRequestDeclined  = "declined"
	GoalRequestExpired   = "expired"
)

// GoalRequestError is a refusal with a stable code.
type GoalRequestError struct{ Code, Message string }

func (e *GoalRequestError) Error() string { return e.Message }
func (e *GoalRequestError) Is(target error) bool {
	t, ok := target.(*GoalRequestError)
	return ok && t.Code == e.Code
}

var (
	ErrGoalRequestNotFound     = &GoalRequestError{"request_not_found", "no such goal request on this board"}
	ErrGoalRequestAnswered     = &GoalRequestError{"request_answered", "this goal request was already answered"}
	ErrGoalRequestExpired      = &GoalRequestError{"request_expired", "this goal request waited too long and expired"}
	ErrGoalRequestAskRequired  = &GoalRequestError{"ask_required", "a goal request needs a text saying what is asked"}
	ErrGoalRequestTooManyTotal = &GoalRequestError{"too_many_pending", "that team has too many goal requests waiting"}
	ErrGoalRequestReplyUnknown = &GoalRequestError{"reply_not_applicable", "no open request of this board matches that reply"}
)

// GoalRequestOut is the asker's row of a request.
type GoalRequestOut struct {
	ID         int64   `db:"id" json:"id"`
	BoardID    string  `db:"board_id" json:"board_id"`
	GoalID     int64   `db:"goal_id" json:"goal_id"`
	RequestID  string  `db:"request_id" json:"request_id"`
	ToServer   string  `db:"to_server" json:"to_server"`
	ToBoard    string  `db:"to_board" json:"to_board"`
	Status     string  `db:"status" json:"status"`
	Reason     string  `db:"reason" json:"reason,omitempty"`
	CreatedBy  string  `db:"created_by" json:"created_by"`
	CreatedAt  string  `db:"created_at" json:"created_at"`
	AnsweredAt *string `db:"answered_at" json:"answered_at,omitempty"`
}

// GoalRequestIn is the receiver's row of a request. Its text is another team's: a caller shows it as untrusted and redacts it.
type GoalRequestIn struct {
	ID         int64   `db:"id" json:"id"`
	BoardID    string  `db:"board_id" json:"board_id"`
	RequestID  string  `db:"request_id" json:"request_id"`
	FromServer string  `db:"from_server" json:"from_server"`
	FromBoard  string  `db:"from_board" json:"from_board"`
	FromSender string  `db:"from_sender" json:"from_sender"`
	GoalUID    string  `db:"goal_uid" json:"goal_uid"`
	GoalTitle  string  `db:"goal_title" json:"goal_title"`
	Ask        string  `db:"ask" json:"ask"`
	Status     string  `db:"status" json:"status"`
	TaskID     *int64  `db:"task_id" json:"task_id,omitempty"`
	Reason     string  `db:"reason" json:"reason,omitempty"`
	DecidedBy  string  `db:"decided_by" json:"decided_by,omitempty"`
	CreatedAt  string  `db:"created_at" json:"created_at"`
	AnsweredAt *string `db:"answered_at" json:"answered_at,omitempty"`
}

const goalRequestOutColumns = `id, board_id, goal_id, request_id, to_server, to_board, status, reason, created_by, created_at, answered_at`
const goalRequestInColumns = `id, board_id, request_id, from_server, from_board, from_sender, goal_uid, goal_title, ask, status, task_id, reason, decided_by, created_at, answered_at`

func (s *Store) ensureGoalRequestsSchema(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS board_goal_requests_out (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			board_id    TEXT NOT NULL,
			goal_id     INTEGER NOT NULL,
			request_id  TEXT NOT NULL,
			to_server   TEXT NOT NULL DEFAULT '',
			to_board    TEXT NOT NULL,
			status      TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'expired')),
			reason      TEXT NOT NULL DEFAULT '',
			created_by  TEXT NOT NULL DEFAULT '',
			created_at  TEXT NOT NULL,
			answered_at TEXT
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_requests_out_rid ON board_goal_requests_out(request_id)`,
		`CREATE INDEX IF NOT EXISTS idx_goal_requests_out_goal ON board_goal_requests_out(board_id, goal_id, status, id)`,
		`CREATE TABLE IF NOT EXISTS board_goal_requests_in (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			board_id    TEXT NOT NULL,
			request_id  TEXT NOT NULL,
			from_server TEXT NOT NULL DEFAULT '',
			from_board  TEXT NOT NULL,
			from_sender TEXT NOT NULL DEFAULT '',
			goal_uid    TEXT NOT NULL,
			goal_title  TEXT NOT NULL DEFAULT '',
			ask         TEXT NOT NULL DEFAULT '',
			status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
			task_id     INTEGER,
			reason      TEXT NOT NULL DEFAULT '',
			decided_by  TEXT NOT NULL DEFAULT '',
			created_at  TEXT NOT NULL,
			answered_at TEXT
		)`,
		// The key of a request is per sender: one sender can never suppress another sender's request by choosing its id.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_requests_in_sender ON board_goal_requests_in(from_server, request_id)`,
		`CREATE INDEX IF NOT EXISTS idx_goal_requests_in_board ON board_goal_requests_in(board_id, status, id)`,
		// A goal's request rows move the board's goal counter (the Goals view refreshes on it): the asker's own, when one is made or answered.
		`CREATE TRIGGER IF NOT EXISTS board_goal_requests_out_seq_insert AFTER INSERT ON board_goal_requests_out BEGIN ` + fmt.Sprintf(goalSeqBump, "NEW.board_id") + ` END`,
		`DROP TRIGGER IF EXISTS board_goal_requests_out_seq_update`,
		`CREATE TRIGGER board_goal_requests_out_seq_update AFTER UPDATE OF status ON board_goal_requests_out WHEN OLD.status IS NOT NEW.status BEGIN ` + fmt.Sprintf(goalSeqBump, "NEW.board_id") + ` END`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	for _, ddl := range []string{
		"ALTER TABLE board_tasks ADD COLUMN remote_board_uid TEXT",
		"ALTER TABLE board_tasks ADD COLUMN remote_goal_uid TEXT",
		"ALTER TABLE board_tasks ADD COLUMN request_id TEXT",
	} {
		if _, err := s.db.ExecContext(ctx, ddl); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	// One task per request, whatever races: a second accept of the same request cannot insert a second task.
	_, err := s.db.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_board_tasks_request ON board_tasks(request_id) WHERE request_id IS NOT NULL`)
	return err
}

// goalSeqBump is the statement that moves a board's goal counter (the same upsert as the goal triggers').
const goalSeqBump = `INSERT INTO board_goal_meta (board_id, seq, updated_at) VALUES (%s, 1, strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ', 'now'))
		ON CONFLICT(board_id) DO UPDATE SET seq = seq + 1, updated_at = excluded.updated_at;`

func newGoalRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// requestText cleans a request's text: no control, bidi or zero-width character, and at most max characters (refused beyond, not cut).
func requestText(field, s string, max int, multiline bool) (string, error) {
	if multiline {
		s = strings.TrimSpace(clitext.Clean(s))
	} else {
		s = clitext.CleanName(s)
	}
	if utf8.RuneCountInString(s) > max {
		return "", &GoalRequestError{"text_too_long", fmt.Sprintf("goal request %s is too long (at most %d characters)", field, max)}
	}
	return s, nil
}

// expireGoalRequests marks the requests older than the TTL that nobody answered, on both sides, as expired.
func (s *Store) expireGoalRequests(ctx context.Context, q sqlExecer) error {
	cutoff := time.Now().UTC().Add(-GoalRequestTTL).Format(time.RFC3339)
	now := nowUTC()
	if _, err := q.ExecContext(ctx, `UPDATE board_goal_requests_in SET status = 'expired', answered_at = ? WHERE status = 'pending' AND created_at < ?`, now, cutoff); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE board_goal_requests_out SET status = 'expired', answered_at = ? WHERE status = 'requested' AND created_at < ?`, now, cutoff)
	return err
}

// reconcileAcceptedRequests marks a pending request accepted when a task made for it exists (a crash between the task and the mark leaves exactly that).
func (s *Store) reconcileAcceptedRequests(ctx context.Context, q sqlExecer) error {
	_, err := q.ExecContext(ctx, `UPDATE board_goal_requests_in
		SET status = 'accepted', task_id = (SELECT id FROM board_tasks WHERE request_id = board_goal_requests_in.request_id AND board_id = board_goal_requests_in.board_id), answered_at = COALESCE(answered_at, ?)
		WHERE status = 'pending' AND EXISTS (SELECT 1 FROM board_tasks WHERE request_id = board_goal_requests_in.request_id AND board_id = board_goal_requests_in.board_id)`, nowUTC())
	return err
}

type sqlExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// SendGoalRequest makes a request from goal goalID of board `from` to board `to` on this computer: the asker's row and the receiver's, in one transaction. title and ask are what the receiver
// will read (the caller has redacted them). The goal must be open (proposed, active or blocked); the receiver's caps hold (20 waiting from this board, 100 in all).
func (s *Store) SendGoalRequest(ctx context.Context, from string, goalID int64, to, ask, createdBy string) (*GoalRequestOut, *GoalRequestIn, error) {
	ask, err := requestText("ask", ask, GoalRequestAskMax, true)
	if err != nil {
		return nil, nil, err
	}
	if ask == "" {
		return nil, nil, ErrGoalRequestAskRequired
	}
	g, err := s.GetGoal(ctx, from, goalID)
	if err != nil {
		return nil, nil, err
	}
	if g.Closed() {
		return nil, nil, ErrGoalClosed
	}
	title := []rune(g.Title)
	if len(title) > GoalRequestTitleMax {
		title = title[:GoalRequestTitleMax]
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	if err := s.expireGoalRequests(ctx, tx); err != nil {
		return nil, nil, err
	}
	var perPair, total int
	if err := tx.GetContext(ctx, &perPair, `SELECT COUNT(*) FROM board_goal_requests_in WHERE board_id = ? AND from_server = '' AND from_board = ? AND status = 'pending'`, to, from); err != nil {
		return nil, nil, err
	}
	if err := tx.GetContext(ctx, &total, `SELECT COUNT(*) FROM board_goal_requests_in WHERE board_id = ? AND status = 'pending'`, to); err != nil {
		return nil, nil, err
	}
	if perPair >= GoalRequestPendingPerPair || total >= GoalRequestPendingPerTarget {
		return nil, nil, ErrGoalRequestTooManyTotal
	}
	rid, now := newGoalRequestID(), nowUTC()
	res, err := tx.ExecContext(ctx, `INSERT INTO board_goal_requests_out (board_id, goal_id, request_id, to_server, to_board, created_by, created_at) VALUES (?, ?, ?, '', ?, ?, ?)`, from, goalID, rid, to, createdBy, now)
	if err != nil {
		return nil, nil, err
	}
	outID, _ := res.LastInsertId()
	res, err = tx.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, from_sender, goal_uid, goal_title, ask, created_at) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`,
		to, rid, from, createdBy, g.UID, string(title), ask, now)
	if err != nil {
		return nil, nil, err
	}
	inID, _ := res.LastInsertId()
	var out GoalRequestOut
	var in GoalRequestIn
	if err := tx.GetContext(ctx, &out, `SELECT `+goalRequestOutColumns+` FROM board_goal_requests_out WHERE id = ?`, outID); err != nil {
		return nil, nil, err
	}
	if err := tx.GetContext(ctx, &in, `SELECT `+goalRequestInColumns+` FROM board_goal_requests_in WHERE id = ?`, inID); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return &out, &in, nil
}

// ListGoalRequestsIn lists the requests received by board, newest first. status "" is every one, else that status; the pending ones past the TTL are marked expired first.
func (s *Store) ListGoalRequestsIn(ctx context.Context, board, status string, limit int) ([]GoalRequestIn, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	if err := s.expireGoalRequests(ctx, s.db); err != nil {
		return nil, err
	}
	if err := s.reconcileAcceptedRequests(ctx, s.db); err != nil {
		return nil, err
	}
	q, args := `SELECT `+goalRequestInColumns+` FROM board_goal_requests_in WHERE board_id = ?`, []any{board}
	if status != "" {
		q += ` AND status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	out := []GoalRequestIn{}
	if err := s.reader().SelectContext(ctx, &out, q, args...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetGoalRequestIn reads one received request of board.
func (s *Store) GetGoalRequestIn(ctx context.Context, board string, id int64) (*GoalRequestIn, error) {
	if err := s.expireGoalRequests(ctx, s.db); err != nil {
		return nil, err
	}
	if err := s.reconcileAcceptedRequests(ctx, s.db); err != nil {
		return nil, err
	}
	var in GoalRequestIn
	if err := s.reader().GetContext(ctx, &in, `SELECT `+goalRequestInColumns+` FROM board_goal_requests_in WHERE board_id = ? AND id = ?`, board, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrGoalRequestNotFound
		}
		return nil, err
	}
	return &in, nil
}

// answerable is the refusal for a request that is not pending, or nil.
func answerable(in *GoalRequestIn) error {
	switch in.Status {
	case GoalRequestPending:
		return nil
	case GoalRequestExpired:
		return ErrGoalRequestExpired
	}
	return ErrGoalRequestAnswered
}

// DeclineGoalRequest declines a pending request with a reason (at most 500 characters, may be empty). It reports the request as it is after.
func (s *Store) DeclineGoalRequest(ctx context.Context, board string, id int64, reason, actor string) (*GoalRequestIn, error) {
	reason, err := requestText("reason", reason, GoalRequestReasonMax, true)
	if err != nil {
		return nil, err
	}
	in, err := s.GetGoalRequestIn(ctx, board, id)
	if err != nil {
		return nil, err
	}
	if err := answerable(in); err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE board_goal_requests_in SET status = 'declined', reason = ?, decided_by = ?, answered_at = ? WHERE board_id = ? AND id = ? AND status = 'pending'`, reason, actor, nowUTC(), board, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrGoalRequestAnswered
	}
	return s.GetGoalRequestIn(ctx, board, id)
}

// AcceptGoalRequest creates a task on board for a pending request, in one step, already linked to the asker's goal (remote_board_uid, remote_goal_uid, request_id). The title, body and
// priority are what the accepting Orchestrator wrote: the request's own text is never copied into the task. One task per request, whatever races (a unique index on the request id); a request
// answered or expired meanwhile leaves no task behind.
func (s *Store) AcceptGoalRequest(ctx context.Context, board string, id int64, title, body, priority, actor string, assignee string) (*Task, *GoalRequestIn, error) {
	in, err := s.GetGoalRequestIn(ctx, board, id)
	if err != nil {
		return nil, nil, err
	}
	if err := answerable(in); err != nil {
		return nil, nil, err
	}
	var boardUID sql.NullString
	if in.FromServer == "" {
		_ = s.reader().GetContext(ctx, &boardUID, `SELECT board_uid FROM boards WHERE id = ?`, in.FromBoard)
	}
	task, err := s.CreateTaskWithOpts(ctx, board, title, body, priority, actor, &CreateTaskOpts{remote: &remoteGoalLink{BoardUID: boardUID.String, GoalUID: in.GoalUID, RequestID: in.RequestID}}, assignee)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: board_tasks.request_id") {
			return nil, nil, ErrGoalRequestAnswered
		}
		return nil, nil, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE board_goal_requests_in SET status = 'accepted', task_id = ?, decided_by = ?, answered_at = ? WHERE board_id = ? AND id = ? AND status = 'pending'`, task.ID, actor, nowUTC(), board, id)
	if err == nil {
		if n, _ := res.RowsAffected(); n == 0 {
			err = ErrGoalRequestAnswered
		}
	}
	if err != nil {
		// Answered meanwhile: the task made for it is taken back, so the request has none.
		_, _ = s.db.ExecContext(ctx, `DELETE FROM task_workflows WHERE task_id = ?`, task.ID)
		_, _ = s.db.ExecContext(ctx, `DELETE FROM board_tasks WHERE id = ? AND board_id = ?`, task.ID, board)
		return nil, nil, err
	}
	after, err := s.GetGoalRequestIn(ctx, board, id)
	return task, after, err
}

// ApplyGoalRequestReply records the other team's answer on the asker's row: only for a request this board made (by its request id), still `requested`, whose target is the board and server
// the reply came from. The first reply wins and a repeat changes nothing; anything else is not applicable. Nothing of the other team's work comes with it: a status and the reason a decline gave.
func (s *Store) ApplyGoalRequestReply(ctx context.Context, board, requestID, fromServer, fromBoard, status, reason string) (*GoalRequestOut, error) {
	if status != GoalRequestAccepted && status != GoalRequestDeclined {
		return nil, ErrGoalRequestReplyUnknown
	}
	reason, err := requestText("reason", reason, GoalRequestReasonMax, true)
	if err != nil {
		return nil, err
	}
	if status == GoalRequestAccepted {
		reason = "" // an accept carries no text
	}
	if err := s.expireGoalRequests(ctx, s.db); err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE board_goal_requests_out SET status = ?, reason = ?, answered_at = ?
		WHERE board_id = ? AND request_id = ? AND to_server = ? AND to_board = ? AND status = 'requested'`, status, reason, nowUTC(), board, requestID, fromServer, fromBoard)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrGoalRequestReplyUnknown
	}
	var out GoalRequestOut
	if err := s.reader().GetContext(ctx, &out, `SELECT `+goalRequestOutColumns+` FROM board_goal_requests_out WHERE request_id = ?`, requestID); err != nil {
		return nil, err
	}
	return &out, nil
}

// GoalRequestsOut lists the requests a goal made (newest first, at most limit), with the count of all of them in each status.
func (s *Store) GoalRequestsOut(ctx context.Context, board string, goalID int64, limit int) ([]GoalRequestOut, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	if err := s.expireGoalRequests(ctx, s.db); err != nil {
		return nil, err
	}
	out := []GoalRequestOut{}
	err := s.reader().SelectContext(ctx, &out, `SELECT `+goalRequestOutColumns+` FROM board_goal_requests_out WHERE board_id = ? AND goal_id = ? ORDER BY id DESC LIMIT ?`, board, goalID, limit)
	return out, err
}

// AcceptedRequestRef is where a goal sent a request that was accepted: the ids and the target as the goal addressed them, no text and nothing of the other team's task.
type AcceptedRequestRef struct {
	RequestID string `db:"request_id" json:"request_id"`
	Server    string `db:"to_server" json:"server"`
	Board     string `db:"to_board" json:"board"`
}

// AcceptedGoalRequests lists a goal's accepted requests, newest first, at most GoalRequestAcceptedListMax, and the total of them.
func (s *Store) AcceptedGoalRequests(ctx context.Context, board string, goalID int64) ([]AcceptedRequestRef, int, error) {
	refs := []AcceptedRequestRef{}
	if err := s.reader().SelectContext(ctx, &refs, `SELECT request_id, to_server, to_board FROM board_goal_requests_out WHERE board_id = ? AND goal_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT ?`, board, goalID, GoalRequestAcceptedListMax); err != nil {
		return nil, 0, err
	}
	var total int
	if err := s.reader().GetContext(ctx, &total, `SELECT COUNT(*) FROM board_goal_requests_out WHERE board_id = ? AND goal_id = ? AND status = 'accepted'`, board, goalID); err != nil {
		return nil, 0, err
	}
	return refs, total, nil
}

// remoteGoalLink is the task-side link to a goal of another team (set only by AcceptGoalRequest: nothing a request carries can set it).
type remoteGoalLink struct{ BoardUID, GoalUID, RequestID string }
