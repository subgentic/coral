package board

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode"

	"github.com/jmoiron/sqlx"
)

// The Activity record (#12064, #12069): one row each time the Operator acts on something in Needs you. It is a record for the Operator, NOT a tamper-proof audit trail: any program that runs as the
// Operator's user can edit the database file. So each row carries the SHA-256 of the row before it and of its own fields, and a head row remembers the last one: an edited or removed row, or rows cut off the
// end, show as a break (VerifyActivity) and the page says "the record was changed outside Coral". That detects tampering; it does not prevent it. Rows are only added here; the only thing that removes
// one is the daily trim by age or count (TrimActivity), which logs how many went. A deleted team's rows stay: a record of what happened is not part of the board.

const (
	// ActivityMaxRows and ActivityMaxAge bound the record: a year or 50,000 rows, whichever is less.
	ActivityMaxRows = 50000
	ActivityMaxAge  = 365 * 24 * time.Hour
	// ActivityNoteCap is the most characters of the Operator's note or chosen option that is kept.
	ActivityNoteCap = 200
	// activityTextCap bounds an item's title (text an agent wrote).
	activityTextCap = 120
	// ActivityMaxLimit is the most rows one read returns (a larger limit is cut to it); the answer says whether more exist.
	ActivityMaxLimit = 200
	// activityTimeFormat is a row's time: UTC with milliseconds, fixed width, so it sorts as text and a merge of several computers' records can order by (time, id).
	activityTimeFormat = "2006-01-02T15:04:05.000Z"
)

// The actions that are recorded.
const (
	ActApprove    = "approve"
	ActChanges    = "changes"
	ActDeny       = "deny"
	ActIgnore     = "ignore"
	ActSupersede  = "supersede"
	ActUnignore   = "unignore"
	ActSave       = "save"
	ActUnsave     = "unsave"
	ActUndone     = "undone" // a decision that was rolled back because the agent could not be told
	ActAnswer     = "answer"
	ActDismiss    = "dismiss"
	ActGoalDone   = "goal_close"
	ActProposal   = "proposal"
	ActMarkRead   = "mark_read"
	ActGoalReview = "goal_review"
	// ActSendReview and ActUnsendReview: the Operator sent a file for review from the Artifacts tab, or took it out again (#13231).
	ActSendReview   = "send_review"
	ActUnsendReview = "unsend_review"
	// ActHubUpdateCheck and ActHubUpdateRelaunch: Coral Hub's owner had this computer check for an update, or relaunch into one it staged (#13340, #13258). The row names the Hub user.
	ActHubUpdateCheck    = "hub_update_check"
	ActHubUpdateRelaunch = "hub_update_relaunch"
	// The rest of what the Operator does in the Inbox and the task pages (#13609): every click that changes something is a row. A task action's item is the task (kind "task"), and an agent
	// action's item is the agent's session name (kind "agent").
	ActTaskCreate   = "task_create"
	ActTaskComplete = "task_complete"
	ActTaskCancel   = "task_cancel"
	ActTaskPublish  = "task_publish"
	ActTaskEdit     = "task_edit"   // the words, the owner, the priority or the goal of a task
	ActTaskRemind   = "task_remind" // a nudge, a reminder, or stopping one
	ActTaskPark     = "task_park"   // park, put back, or release a task
	ActTaskReply    = "task_reply"  // the Operator's words on a task
	ActPromptAnswer = "prompt_answer"
	ActWaitDismiss  = "wait_dismiss"
	ActWaitSend     = "wait_send"
	ActMessage      = "message" // a message the Operator posted to a team's board
	// Slice 2 (#13609): the rest of the Inbox, Files, Saved and Chats clicks.
	ActMarkUnread     = "mark_unread" // with ActMarkRead: the explicit Mark read and Mark unread buttons (opening a file marks it read by itself: not a click)
	ActFileTags       = "file_tags"   // the tag editor of a file
	ActFileStar       = "file_star"
	ActFileUnstar     = "file_unstar"
	ActFileKeep       = "file_keep"
	ActFileRelease    = "file_release"
	ActFileDelete     = "file_delete"
	ActFileShare      = "file_share" // a file shared with an agent
	ActSavedAdd       = "saved_add"
	ActSavedUpdate    = "saved_update" // Done or Reopen on a saved message
	ActSavedRemove    = "saved_remove"
	ActChatFlag       = "chat_flag" // star or archive of a chat
	ActChatSend       = "chat_send" // the chat composer's Send to an agent
	ActRunSeen        = "run_seen"  // a failed run opened or dismissed
	ActAgentsRecord   = "agents_record"
	ActGoalCreate     = "goal_create"
	ActGoalEdit       = "goal_edit" // a goal's words, or Reopen
	ActGoalDriver     = "goal_driver"
	ActGoalMove       = "goal_move"
	ActGoalRequestAdd = "goal_request_accept"
	ActGoalRequestNo  = "goal_request_decline"
	ActInboxHide      = "inbox_hide" // Dismiss or Not yet on a goal-looks-done row, a welcome item's Dismiss: kept in settings
)

// ActivityMeta is what a handler knows about the action, set on the context so the store's own transaction can write the row: the actor and source come from the verified request, never the body.
type ActivityMeta struct {
	Actor   string // "local", or "hub:" and an opaque label of the Hub account
	Source  string // "local" or "hub", from the request's own provenance
	Hint    string // "phone" or "": what the page said about itself, shown as reported by the page
	Surface string // "inbox", "chat" or "": which part of the page the action was taken in, as the page said (a closed list; anything else is nothing)
	Note    string // already cleaned, redacted and cut by the caller ("" when the redactor refused)
	Title   string // the item's title as text (cleaned and cut here)
}

type activityKey struct{}

// WithActivity says an action on this context is the Operator's, so a store write that is one of the recorded actions also records it, in its own transaction.
func WithActivity(ctx context.Context, m ActivityMeta) context.Context {
	return context.WithValue(ctx, activityKey{}, m)
}

func activityOf(ctx context.Context) (ActivityMeta, bool) {
	m, ok := ctx.Value(activityKey{}).(ActivityMeta)
	return m, ok
}

// OperatorAction is one row of the record.
type OperatorAction struct {
	ID       int64  `db:"id" json:"id"`
	At       string `db:"at" json:"at"`
	Actor    string `db:"actor" json:"actor"`
	Action   string `db:"action" json:"action"`
	ItemKind string `db:"item_kind" json:"item_kind"` // file, question, goal, proposal, message
	ItemID   string `db:"item_id" json:"item_id"`
	Version  string `db:"version" json:"version,omitempty"` // a file: the digest of the exact version acted on
	Team     string `db:"team" json:"team"`
	Source   string `db:"source" json:"source"`
	Hint     string `db:"hint" json:"hint,omitempty"`
	Surface  string `db:"surface" json:"surface,omitempty"` // what the page said it was (inbox or chat), like Hint: a page-reported word from a closed list, never text
	Title    string `db:"title" json:"title,omitempty"`
	Note     string `db:"note" json:"note,omitempty"`
	PrevHash string `db:"prev_hash" json:"-"`
	Hash     string `db:"hash" json:"-"`
}

func (s *Store) ensureOperatorActionsSchema(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS operator_actions (
		id        INTEGER PRIMARY KEY AUTOINCREMENT,
		at        TEXT NOT NULL,
		actor     TEXT NOT NULL,
		action    TEXT NOT NULL,
		item_kind TEXT NOT NULL,
		item_id   TEXT NOT NULL,
		version   TEXT NOT NULL DEFAULT '',
		team      TEXT NOT NULL,
		source    TEXT NOT NULL,
		hint      TEXT NOT NULL DEFAULT '',
		surface   TEXT NOT NULL DEFAULT '',
		title     TEXT NOT NULL DEFAULT '',
		note      TEXT NOT NULL DEFAULT '',
		prev_hash TEXT NOT NULL,
		hash      TEXT NOT NULL
	)`); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_operator_actions_team ON operator_actions(team, id)`); err != nil {
		return err
	}
	// this record's own id, made once and never derived from anything else (not the telemetry id): the Hub pairs it with a row's id, which is unique only within one computer's record
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS operator_actions_record (one INTEGER PRIMARY KEY CHECK (one = 1), record_id TEXT NOT NULL)`); err != nil {
		return err
	}
	var rid [16]byte
	if _, err := rand.Read(rid[:]); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO operator_actions_record (one, record_id) VALUES (1, ?)`, hex.EncodeToString(rid[:])); err != nil {
		return err
	}
	// the head: the id and hash of the newest row ever added (so rows cut off the end show), and the id and previous hash of the oldest kept row (the anchor: rows cut off the front show), which only a trim moves
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS operator_actions_head (
		one       INTEGER PRIMARY KEY CHECK (one = 1),
		last_id   INTEGER NOT NULL,
		last_hash TEXT NOT NULL,
		first_id        INTEGER NOT NULL,
		first_prev_hash TEXT NOT NULL
	)`)
	return err
}

// activityText is text that an agent wrote or the Operator typed, made safe to store and to show: control, zero-width and reordering characters gone, runs of space one, cut to n characters.
func activityText(s string, n int) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case unicode.Is(unicode.Cf, r), unicode.Is(unicode.Zl, r), unicode.Is(unicode.Zp, r), unicode.IsControl(r) && !unicode.IsSpace(r):
			continue // every format character (zero-width, bidi marks and overrides, the tag block), the line and paragraph separators, and control characters are dropped
		case unicode.IsSpace(r):
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	out := []rune(b.String())
	if len(out) > n {
		out = out[:n]
	}
	return string(out)
}

// activityHash chains a row: the SHA-256 of the previous hash and of every field of this row, each length-prefixed so no two rows hash alike by moving a character between fields.
func activityHash(prev string, a OperatorAction) string {
	h := sha256.New()
	for _, f := range []string{prev, a.At, a.Actor, a.Action, a.ItemKind, a.ItemID, a.Version, a.Team, a.Source, a.Hint, a.Surface, a.Title, a.Note} {
		fmt.Fprintf(h, "%d:%s|", len(f), f)
	}
	return hex.EncodeToString(h.Sum(nil))
}

type activityExec interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	GetContext(ctx context.Context, dest any, query string, args ...any) error
}

// appendActivity adds one row to the chain through q (a transaction, when the action is a write in this database: then the row exists exactly when the action happened). The caller holds s.activityMu.
func appendActivity(ctx context.Context, q activityExec, now time.Time, m ActivityMeta, action, kind, item, version, team string) error {
	var head struct {
		LastID   int64  `db:"last_id"`
		LastHash string `db:"last_hash"`
	}
	if err := q.GetContext(ctx, &head, `SELECT last_id, last_hash FROM operator_actions_head WHERE one = 1`); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	source := m.Source
	if source != "hub" {
		source = "local"
	}
	hint := ""
	if m.Hint == "phone" {
		hint = "phone"
	}
	surface := ValidSurface(m.Surface)
	a := OperatorAction{At: now.UTC().Format(activityTimeFormat), Actor: m.Actor, Action: action, ItemKind: kind, ItemID: item, Version: version, Team: team, Source: source, Hint: hint, Surface: surface,
		Title: activityText(m.Title, activityTextCap), Note: activityText(m.Note, ActivityNoteCap), PrevHash: head.LastHash}
	if a.Actor == "" {
		a.Actor = "local"
	}
	a.Hash = activityHash(a.PrevHash, a)
	// the row and the head are one step: a failure between them leaves neither (a savepoint inside the caller's transaction), so the chain never shows a break the action did not cause
	if _, err := q.ExecContext(ctx, `SAVEPOINT activity_row`); err != nil {
		return err
	}
	fail := func(err error) error {
		_, _ = q.ExecContext(ctx, `ROLLBACK TO activity_row`)
		_, _ = q.ExecContext(ctx, `RELEASE activity_row`)
		return err
	}
	res, err := q.ExecContext(ctx, `INSERT INTO operator_actions (at, actor, action, item_kind, item_id, version, team, source, hint, surface, title, note, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.At, a.Actor, a.Action, a.ItemKind, a.ItemID, a.Version, a.Team, a.Source, a.Hint, a.Surface, a.Title, a.Note, a.PrevHash, a.Hash)
	if err != nil {
		return fail(err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return fail(err)
	}
	// the anchor is set by the first row ever and moved only by TrimActivity
	if _, err := q.ExecContext(ctx, `INSERT INTO operator_actions_head (one, last_id, last_hash, first_id, first_prev_hash) VALUES (1, ?, ?, ?, ?) ON CONFLICT(one) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash`, id, a.Hash, id, a.PrevHash); err != nil {
		return fail(err)
	}
	_, err = q.ExecContext(ctx, `RELEASE activity_row`)
	return err
}

// recordInTx writes the row for ctx's action in tx when the context says the Operator acted. A failure to write it is the transaction's failure only for a board write the row must match; the caller decides.
func (s *Store) recordInTx(ctx context.Context, tx *sqlx.Tx, now time.Time, action, kind, item, version, team string) error {
	m, ok := activityOf(ctx)
	if !ok {
		return nil
	}
	return appendActivity(ctx, tx, now, m, action, kind, item, version, team)
}

// RecordActivity adds a row for an action that is not a write in this database's own transaction (best effort: a crash between the action and its row can lose one row). It never returns an error that
// should stop the Operator's action: the failure is logged and returned for a test.
func (s *Store) RecordActivity(ctx context.Context, m ActivityMeta, action, kind, item, version, team string) error {
	s.activityMu.Lock()
	defer s.activityMu.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		slog.Warn("[activity] row not recorded", "action", action, "error", err)
		return err
	}
	defer tx.Rollback()
	if err := appendActivity(ctx, tx, time.Now(), m, action, kind, item, version, team); err != nil {
		slog.Warn("[activity] row not recorded", "action", action, "error", err)
		return err
	}
	if err := tx.Commit(); err != nil {
		slog.Warn("[activity] row not recorded", "action", action, "error", err)
		return err
	}
	return nil
}

// ActivityCheck is what VerifyActivity found.
type ActivityCheck struct {
	Rows     int    `json:"rows"`
	Intact   bool   `json:"intact"`
	FirstBad int64  `json:"first_bad,omitempty"` // the id of the first row that does not match (0 when the break is rows missing from an end)
	Reason   string `json:"reason,omitempty"`    // "edited", "removed" or "cut_off"
	// Note is what the check can and cannot say, kept here so the page and the release text cannot say more than it does: the chain has no secret, so a program that can write the database can re-hash every row
	// and the head and leave no break.
	Note string `json:"note"`
}

// ActivityCheckNote is the sentence the page shows with the check.
const ActivityCheckNote = "Edits made outside Coral are shown unless the whole record was rewritten."

// VerifyActivity walks the chain from the oldest kept row, compares that row with the head's anchor (rows cut off the front), and the last row with the head's last (rows cut off the end). The rows a trim
// removed are not checked: the trim moved the anchor.
func (s *Store) VerifyActivity(ctx context.Context) (ActivityCheck, error) {
	rows := []OperatorAction{}
	if err := s.db.SelectContext(ctx, &rows, `SELECT id, at, actor, action, item_kind, item_id, version, team, source, hint, surface, title, note, prev_hash, hash FROM operator_actions ORDER BY id`); err != nil {
		return ActivityCheck{}, err
	}
	var head struct {
		LastID        int64  `db:"last_id"`
		LastHash      string `db:"last_hash"`
		FirstID       int64  `db:"first_id"`
		FirstPrevHash string `db:"first_prev_hash"`
	}
	haveHead := true
	if err := s.db.GetContext(ctx, &head, `SELECT last_id, last_hash, first_id, first_prev_hash FROM operator_actions_head WHERE one = 1`); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return ActivityCheck{}, err
		}
		haveHead = false
	}
	broken := func(first int64, reason string) (ActivityCheck, error) {
		return ActivityCheck{Rows: len(rows), FirstBad: first, Reason: reason, Note: ActivityCheckNote}, nil
	}
	for i, a := range rows {
		if activityHash(a.PrevHash, a) != a.Hash {
			return broken(a.ID, "edited")
		}
		if i > 0 && a.PrevHash != rows[i-1].Hash {
			return broken(a.ID, "removed")
		}
	}
	switch {
	case !haveHead && len(rows) > 0:
		return broken(0, "cut_off")
	case !haveHead:
		// nothing was ever recorded
	case len(rows) == 0 && head.FirstID <= head.LastID:
		return broken(0, "cut_off") // rows were there and are not (a trim leaves the anchor past the last row when it removes them all)
	case len(rows) > 0 && (rows[0].ID != head.FirstID || rows[0].PrevHash != head.FirstPrevHash):
		return broken(rows[0].ID, "removed") // the oldest rows were cut off by something other than the trim
	case len(rows) > 0 && (rows[len(rows)-1].ID != head.LastID || rows[len(rows)-1].Hash != head.LastHash):
		return broken(0, "cut_off")
	}
	return ActivityCheck{Rows: len(rows), Intact: true, Note: ActivityCheckNote}, nil
}

// ActivityFilter narrows a list.
type ActivityFilter struct {
	Team, Action string
	Actor        string // only this actor's rows (a team's owner reads their own rows alone: the Operator's choice, #12070)
	BeforeID     int64  // rows older than this id (the next page)
	BeforeAt     string // with BeforeID: rows older than this (time, id), the cursor a merge of several computers' records pages by
	Limit        int
}

// ActivityRecordID is this computer's record's own id (see operator_actions_record).
func (s *Store) ActivityRecordID(ctx context.Context) (string, error) {
	var id string
	err := s.reader().GetContext(ctx, &id, `SELECT record_id FROM operator_actions_record WHERE one = 1`)
	return id, err
}

// ListActivity is the newest rows first, a page at a time.
func (s *Store) ListActivity(ctx context.Context, f ActivityFilter) ([]OperatorAction, error) {
	rows, _, err := s.ActivityPage(ctx, f)
	return rows, err
}

// ActivityPage is ListActivity and whether more rows exist past the page (it reads one more than the limit). The limit is at most ActivityMaxLimit and 50 when not given; the order is (time, id) newest
// first, and a cursor (BeforeAt with BeforeID) pages by that pair.
func (s *Store) ActivityPage(ctx context.Context, f ActivityFilter) ([]OperatorAction, bool, error) {
	q := `SELECT id, at, actor, action, item_kind, item_id, version, team, source, hint, surface, title, note FROM operator_actions WHERE 1 = 1`
	var args []any
	if f.Team != "" {
		q += ` AND team = ?`
		args = append(args, f.Team)
	}
	if f.Action != "" {
		q += ` AND action = ?`
		args = append(args, f.Action)
	}
	if f.Actor != "" {
		q += ` AND actor = ?`
		args = append(args, f.Actor)
	}
	switch {
	case f.BeforeID > 0 && f.BeforeAt != "":
		q += ` AND (at < ? OR (at = ? AND id < ?))`
		args = append(args, f.BeforeAt, f.BeforeAt, f.BeforeID)
	case f.BeforeID > 0:
		q += ` AND id < ?`
		args = append(args, f.BeforeID)
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	if f.Limit > ActivityMaxLimit {
		f.Limit = ActivityMaxLimit
	}
	q += ` ORDER BY at DESC, id DESC LIMIT ?`
	args = append(args, f.Limit+1)
	out := []OperatorAction{}
	if err := s.db.SelectContext(ctx, &out, q, args...); err != nil {
		return nil, false, err
	}
	more := len(out) > f.Limit
	if more {
		out = out[:f.Limit]
	}
	return out, more, nil
}

// TrimActivity removes rows older than ActivityMaxAge, then the oldest beyond ActivityMaxRows, and answers how many went (the caller logs the number: no content, so a gap is explained). Only the oldest
// rows can go, so the chain from the oldest kept row on is whole, and the head's anchor moves to that row (past the last row when all went): nothing else moves it.
func (s *Store) TrimActivity(ctx context.Context, now time.Time) (int, error) {
	s.activityMu.Lock()
	defer s.activityMu.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	cut := now.Add(-ActivityMaxAge).UTC().Format(activityTimeFormat)
	res, err := tx.ExecContext(ctx, `DELETE FROM operator_actions WHERE at < ? AND id <= COALESCE((SELECT MAX(id) FROM operator_actions WHERE at < ?), 0)`, cut, cut)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	res, err = tx.ExecContext(ctx, `DELETE FROM operator_actions WHERE id <= (SELECT id FROM operator_actions ORDER BY id DESC LIMIT 1 OFFSET ?)`, ActivityMaxRows)
	if err != nil {
		return 0, err
	}
	m, _ := res.RowsAffected()
	if n+m == 0 {
		return 0, nil
	}
	var first struct {
		ID       int64  `db:"id"`
		PrevHash string `db:"prev_hash"`
	}
	if err := tx.GetContext(ctx, &first, `SELECT id, prev_hash FROM operator_actions ORDER BY id LIMIT 1`); err == nil {
		_, err = tx.ExecContext(ctx, `UPDATE operator_actions_head SET first_id = ?, first_prev_hash = ? WHERE one = 1`, first.ID, first.PrevHash)
		if err != nil {
			return 0, err
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx, `UPDATE operator_actions_head SET first_id = last_id + 1, first_prev_hash = last_hash WHERE one = 1`); err != nil {
			return 0, err
		}
	} else {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int(n + m), nil
}

// noteActivity writes the row of an action in its own transaction. A row that cannot be written is logged and the action stands: the record never blocks the Operator.
func (s *Store) noteActivity(ctx context.Context, tx *sqlx.Tx, now time.Time, action, kind, item, version, team string) {
	if action == "" {
		return
	}
	if err := s.recordInTx(ctx, tx, now, action, kind, item, version, team); err != nil {
		slog.Warn("[activity] row not recorded", "action", action, "error", err)
	}
}

// CountActivityBy is how many rows one actor has in the record.
func (s *Store) CountActivityBy(ctx context.Context, actor string) (int, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM operator_actions WHERE actor = ?`, actor)
	return n, err
}

// The surfaces an action can be taken in, as the page says (the Operator's Inbox versus an agent's chat or terminal, #12158). The page sends one of these words in a header on the person-only routes it calls; the server
// keeps it only if it is on this list, and anything else is nothing. It is what the page said, and is shown as that: it cannot carry anything but one of two words.
const (
	SurfaceInbox = "inbox"
	SurfaceChat  = "chat"
)

// ValidSurface is s when it is a surface, else "" (nothing).
func ValidSurface(s string) string {
	if s == SurfaceInbox || s == SurfaceChat {
		return s
	}
	return ""
}
