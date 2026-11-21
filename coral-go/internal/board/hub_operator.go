package board

import (
	"context"
	"strings"
	"sync/atomic"
	"time"
)

// HubOperatorAction records one use of the Operator identity by a Coral Hub user through
// the tunnel (#3404): a chat post, a cross-team post or a task action. HubUser is the
// validated, tunnel-stamped X-Coral-Hub-User, never a name from the request body.
type HubOperatorAction struct {
	ID      int64  `db:"id" json:"id"`
	At      string `db:"at" json:"at"`
	HubUser string `db:"hub_user" json:"hub_user"`
	// HubUserID is the person's stable Coral Hub id (hub-uid-<32 hex>) when the machine is a team's and the stamp carried one (#7061): the label in HubUser can be renamed or reused, the id is
	// not. "" for a personal machine's actions, and for everything recorded before this.
	HubUserID string `db:"hub_user_id" json:"hub_user_id,omitempty"`
	// ViaLink and ViaHubUser are the pair the connector stamped (#20312, multi-Hub design v2 2.6): the cloud_link the request arrived on (lnk-<8 hex>) and the Hub person behind it (hub-user-<8 hex>).
	// Both are "" for an action recorded before this and for a local action. The pair is attribution only, never authority.
	ViaLink    string `db:"via_link" json:"via_link,omitempty"`
	ViaHubUser string `db:"via_hub_user" json:"via_hub_user,omitempty"`
	// Kind is "" for the security rows (a use of the Operator identity, a switch, a device key, the cloud link) and HubActionKindWrite for the one-line row the write wrapper leaves for a tunneled write
	// (#20369). Each kind has its own bound, so a flood of writes can never push a security row out.
	Kind    string `db:"kind" json:"kind,omitempty"`
	Method  string `db:"method" json:"method"`
	Path    string `db:"path" json:"path"`
	Project string `db:"project" json:"project"`
	Status  int    `db:"status" json:"status"`
}

// ActionVia is the pair the connector stamped on a tunneled request (#20312): the cloud_link it arrived on (lnk-<8 hex>) and the Hub person behind it (hub-user-<8 hex>, or "" when the stream
// named no one). It travels in the request's context and every writer of the Operator-actions record reads it from there, so no caller passes it and none can forget it. Attribution only,
// never authority. It lives here, with the record, so internal/cloud (which sets it) and this package need no import of each other.
type ActionVia struct {
	LinkID  string
	HubUser string
}

type actionViaKey struct{}

// WithActionVia returns ctx carrying v.
func WithActionVia(ctx context.Context, v ActionVia) context.Context {
	return context.WithValue(ctx, actionViaKey{}, v)
}

// ActionViaFrom returns the pair ctx carries; ok is false for a local action.
func ActionViaFrom(ctx context.Context) (ActionVia, bool) {
	v, ok := ctx.Value(actionViaKey{}).(ActionVia)
	return v, ok
}

// actionRecorded is a flag a request carries so the one wrapper that records tunneled writes (routes.RecordPairWrites, #20369) knows a handler already wrote the Operator-actions row for it and
// records nothing a second time. It is set only by a writer of that row.
type actionRecorded struct{ done atomic.Bool }

type actionRecordedKey struct{}

// WithActionRecordFlag returns ctx carrying a fresh flag and the flag itself.
func WithActionRecordFlag(ctx context.Context) (context.Context, *atomic.Bool) {
	f := &actionRecorded{}
	return context.WithValue(ctx, actionRecordedKey{}, f), &f.done
}

// markActionRecorded says that the row for this request was written.
func markActionRecorded(ctx context.Context) {
	if f, ok := ctx.Value(actionRecordedKey{}).(*actionRecorded); ok {
		f.done.Store(true)
	}
}

// HubActionKindWrite is the Kind of a row left by routes.RecordPairWrites.
const HubActionKindWrite = "write"

// HubActionKindStream is the Kind of the WS-OPEN and WS-CLOSE rows of a tunneled WebSocket (#20405, #20449): a stream has its own bound, so a flood of opens cannot push write rows out of their newest 1000.
const HubActionKindStream = "stream"

// hubOperatorActionsKept bounds each kind of the table: the newest actions of that kind are kept (the write rows are many; the security rows must outlast them).
const hubOperatorActionsKept = 1000

func (s *Store) ensureHubOperatorActionsSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS hub_operator_actions (
		id       INTEGER PRIMARY KEY AUTOINCREMENT,
		at       TEXT NOT NULL,
		hub_user TEXT NOT NULL,
		method   TEXT NOT NULL,
		path     TEXT NOT NULL,
		project  TEXT NOT NULL,
		status   INTEGER NOT NULL
	)`)
	if err != nil {
		return err
	}
	// The person's stable id (#7061): added to a table made before it existed; a repeat is the "duplicate column" answer.
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE hub_operator_actions ADD COLUMN hub_user_id TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column") {
		return err
	}
	for _, col := range []string{"via_link", "via_hub_user", "kind"} { // the link pair (#20312)
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE hub_operator_actions ADD COLUMN `+col+` TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	return nil
}

// RecordHubOperatorAction stores a, keeping the newest hubOperatorActionsKept.
func (s *Store) RecordHubOperatorAction(ctx context.Context, a HubOperatorAction) error {
	if a.At == "" {
		a.At = time.Now().UTC().Format(time.RFC3339)
	}
	if v, ok := ActionViaFrom(ctx); ok && a.ViaLink == "" {
		a.ViaLink, a.ViaHubUser = v.LinkID, v.HubUser
	}
	markActionRecorded(ctx)
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO hub_operator_actions (at, hub_user, hub_user_id, via_link, via_hub_user, kind, method, path, project, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.At, a.HubUser, a.HubUserID, a.ViaLink, a.ViaHubUser, a.Kind, a.Method, a.Path, a.Project, a.Status)
	if err != nil {
		return err
	}
	if _, err := res.LastInsertId(); err != nil {
		return nil
	}
	// keep the newest hubOperatorActionsKept of THIS kind: the Nth newest row's id is the line, and nothing of this kind at or below it stays
	var line int64
	if err := s.db.GetContext(ctx, &line, `SELECT id FROM hub_operator_actions WHERE kind = ? ORDER BY id DESC LIMIT 1 OFFSET ?`, a.Kind, hubOperatorActionsKept); err != nil {
		return nil // fewer rows than the bound (sql.ErrNoRows), or nothing to prune
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM hub_operator_actions WHERE kind = ? AND id <= ?`, a.Kind, line)
	return err
}

// RecentHubOperatorActions returns up to limit actions, newest first.
func (s *Store) RecentHubOperatorActions(ctx context.Context, limit int) ([]HubOperatorAction, error) {
	out := []HubOperatorAction{}
	err := s.db.SelectContext(ctx, &out,
		`SELECT id, at, hub_user, hub_user_id, via_link, via_hub_user, kind, method, path, project, status FROM hub_operator_actions ORDER BY id DESC LIMIT ?`, limit)
	return out, err
}
