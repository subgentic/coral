package board

import (
	"context"
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
)

// The actions that are recorded.
const (
	ActApprove    = "approve"
	ActChanges    = "changes"
	ActDeny       = "deny"
	ActIgnore     = "ignore"
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
)

// ActivityMeta is what a handler knows about the action, set on the context so the store's own transaction can write the row: the actor and source come from the verified request, never the body.
type ActivityMeta struct {
	Actor  string // "local", or "hub:" and an opaque label of the Hub account
	Source string // "local" or "hub", from the request's own provenance
	Hint   string // "phone" or "": what the page said about itself, shown as reported by the page
	Note   string // already cleaned, redacted and cut by the caller ("" when the redactor refused)
	Title  string // the item's title as text (cleaned and cut here)
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
	// the head: the id and hash of the newest row ever added, so rows cut off the end show too (a trim never moves it)
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS operator_actions_head (
		one       INTEGER PRIMARY KEY CHECK (one = 1),
		last_id   INTEGER NOT NULL,
		last_hash TEXT NOT NULL
	)`)
	return err
}

// activityText is text that an agent wrote or the Operator typed, made safe to store and to show: control, zero-width and reordering characters gone, runs of space one, cut to n characters.
func activityText(s string, n int) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			space = true
			continue
		case unicode.IsControl(r), r == 0x200b || r == 0x200c || r == 0x200d || r == 0x2060 || r == 0xfeff, r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
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
	for _, f := range []string{prev, a.At, a.Actor, a.Action, a.ItemKind, a.ItemID, a.Version, a.Team, a.Source, a.Hint, a.Title, a.Note} {
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
	a := OperatorAction{At: now.UTC().Format(time.RFC3339), Actor: m.Actor, Action: action, ItemKind: kind, ItemID: item, Version: version, Team: team, Source: source, Hint: hint,
		Title: activityText(m.Title, activityTextCap), Note: activityText(m.Note, ActivityNoteCap), PrevHash: head.LastHash}
	if a.Actor == "" {
		a.Actor = "local"
	}
	a.Hash = activityHash(a.PrevHash, a)
	res, err := q.ExecContext(ctx, `INSERT INTO operator_actions (at, actor, action, item_kind, item_id, version, team, source, hint, title, note, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.At, a.Actor, a.Action, a.ItemKind, a.ItemID, a.Version, a.Team, a.Source, a.Hint, a.Title, a.Note, a.PrevHash, a.Hash)
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `INSERT INTO operator_actions_head (one, last_id, last_hash) VALUES (1, ?, ?) ON CONFLICT(one) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash`, id, a.Hash)
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
	FirstBad int64  `json:"first_bad,omitempty"` // the id of the first row that does not match (0 when the break is rows missing from the end)
	Reason   string `json:"reason,omitempty"`    // "edited", "removed" or "cut_off"
}

// VerifyActivity walks the chain from the oldest kept row and compares the last hash with the head's. The oldest kept row's own previous hash is its anchor (the rows a trim removed are not checked).
func (s *Store) VerifyActivity(ctx context.Context) (ActivityCheck, error) {
	rows := []OperatorAction{}
	if err := s.db.SelectContext(ctx, &rows, `SELECT id, at, actor, action, item_kind, item_id, version, team, source, hint, title, note, prev_hash, hash FROM operator_actions ORDER BY id`); err != nil {
		return ActivityCheck{}, err
	}
	var head struct {
		LastID   int64  `db:"last_id"`
		LastHash string `db:"last_hash"`
	}
	haveHead := true
	if err := s.db.GetContext(ctx, &head, `SELECT last_id, last_hash FROM operator_actions_head WHERE one = 1`); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return ActivityCheck{}, err
		}
		haveHead = false
	}
	res := ActivityCheck{Rows: len(rows), Intact: true}
	for i, a := range rows {
		if activityHash(a.PrevHash, a) != a.Hash {
			return ActivityCheck{Rows: len(rows), FirstBad: a.ID, Reason: "edited"}, nil
		}
		if i > 0 && a.PrevHash != rows[i-1].Hash {
			return ActivityCheck{Rows: len(rows), FirstBad: a.ID, Reason: "removed"}, nil
		}
	}
	if haveHead {
		switch {
		case len(rows) == 0 && head.LastID > 0:
			return ActivityCheck{Rows: 0, Reason: "cut_off"}, nil
		case len(rows) > 0 && (rows[len(rows)-1].ID != head.LastID || rows[len(rows)-1].Hash != head.LastHash):
			return ActivityCheck{Rows: len(rows), Reason: "cut_off"}, nil
		}
	} else if len(rows) > 0 {
		return ActivityCheck{Rows: len(rows), Reason: "cut_off"}, nil
	}
	return res, nil
}

// ActivityFilter narrows a list.
type ActivityFilter struct {
	Team, Action string
	BeforeID     int64 // rows older than this id (the next page)
	Limit        int
}

// ListActivity is the newest rows first, a page at a time.
func (s *Store) ListActivity(ctx context.Context, f ActivityFilter) ([]OperatorAction, error) {
	q := `SELECT id, at, actor, action, item_kind, item_id, version, team, source, hint, title, note FROM operator_actions WHERE 1 = 1`
	var args []any
	if f.Team != "" {
		q += ` AND team = ?`
		args = append(args, f.Team)
	}
	if f.Action != "" {
		q += ` AND action = ?`
		args = append(args, f.Action)
	}
	if f.BeforeID > 0 {
		q += ` AND id < ?`
		args = append(args, f.BeforeID)
	}
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, f.Limit)
	out := []OperatorAction{}
	err := s.db.SelectContext(ctx, &out, q, args...)
	return out, err
}

// TrimActivity removes rows older than ActivityMaxAge, then the oldest beyond ActivityMaxRows, and answers how many went (the caller logs the number: no content, so a gap is explained). Only the oldest
// rows can go, so the chain from the oldest kept row on is whole; the head is not touched.
func (s *Store) TrimActivity(ctx context.Context, now time.Time) (int, error) {
	s.activityMu.Lock()
	defer s.activityMu.Unlock()
	cut := now.Add(-ActivityMaxAge).UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `DELETE FROM operator_actions WHERE at < ? AND id <= COALESCE((SELECT MAX(id) FROM operator_actions WHERE at < ?), 0)`, cut, cut)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	res, err = s.db.ExecContext(ctx, `DELETE FROM operator_actions WHERE id <= (SELECT id FROM operator_actions ORDER BY id DESC LIMIT 1 OFFSET ?)`, ActivityMaxRows)
	if err != nil {
		return int(n), err
	}
	m, _ := res.RowsAffected()
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
