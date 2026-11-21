package board

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
)

// The member grant (#20387, G1-G6): what a Hub person may do on ONE board of this computer, held here. It is written only by the Operator at this computer (the route is never reachable through a Hub and
// no Hub field writes a row), keyed by the link and the Hub person the connector stamped, naming one board by its id, with a level and a mandatory expiry. The Hub never holds the authority: it names a
// person, and this table says what that person may do. Reads of it are made on every call, never cached.

// Member levels. A member is never an owner: "view" reads the board, "team" may also send to one agent of it and post to it.
const (
	MemberLevelView = "view"
	MemberLevelTeam = "team"
)

// Bounds on a grant.
const (
	MemberGrantMaxDays      = 30 // the longest a grant lives
	MemberGrantDefaultDays  = 7
	MemberGrantsPerBoard    = 20 // live grants on one board
	MemberGrantsPerPerson   = 5  // live grants for one (link, Hub person)
	maxMemberGrantLabelRune = 40
)

var (
	// ErrMemberGrant is a grant that cannot be made: the message says why in plain words.
	ErrMemberGrant = errors.New("the member grant is not valid")
	// ErrNoMemberGrant is a grant that is not there (or not live).
	ErrNoMemberGrant = errors.New("no such member grant")

	memberLinkRe = regexp.MustCompile(`^lnk-[0-9a-f]{8}$`)
	memberUserRe = regexp.MustCompile(`^hub-user-[0-9a-f]{8}$`)
	memberIDRe   = regexp.MustCompile(`^mg-[0-9a-f]{16}$`)
)

// MemberGrant is one row.
type MemberGrant struct {
	GrantID   string  `db:"grant_id" json:"grant_id"`
	LinkID    string  `db:"link_id" json:"link_id"`
	HubUser   string  `db:"hub_user" json:"hub_user"`
	BoardID   string  `db:"board_id" json:"board_id"`
	Level     string  `db:"level" json:"level"`
	Label     string  `db:"label" json:"label"`
	CreatedAt string  `db:"created_at" json:"created_at"`
	ExpiresAt string  `db:"expires_at" json:"expires_at"`
	RevokedAt *string `db:"revoked_at" json:"revoked_at,omitempty"`
}

// NewMemberGrant is what the Operator asks for.
type NewMemberGrant struct {
	LinkID  string
	HubUser string
	BoardID string
	Level   string
	Label   string
	Days    int // 0 is MemberGrantDefaultDays
}

func (s *Store) ensureMemberGrantSchema(ctx context.Context) error {
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS member_grant (
			grant_id   TEXT PRIMARY KEY,
			link_id    TEXT NOT NULL,
			hub_user   TEXT NOT NULL,
			board_id   TEXT NOT NULL,
			level      TEXT NOT NULL,
			label      TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			revoked_at TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_member_grant_pair ON member_grant(link_id, hub_user, board_id)`,
		// The audit of grants: who was given what, by the Operator here, and what ended it. There is no text field: nothing a person wrote is kept here.
		`CREATE TABLE IF NOT EXISTS member_grant_audit (
			id       INTEGER PRIMARY KEY AUTOINCREMENT,
			at       TEXT NOT NULL,
			grant_id TEXT NOT NULL,
			event    TEXT NOT NULL,
			link_id  TEXT NOT NULL,
			hub_user TEXT NOT NULL,
			board_id TEXT NOT NULL,
			level    TEXT NOT NULL
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, ddl); err != nil {
			return err
		}
	}
	return nil
}

func memberErr(why string) error { return errors.Join(ErrMemberGrant, errors.New(why)) }

// CleanMemberLabel is the label as it may be stored: one cleaned line the Operator typed, at most maxMemberGrantLabelRune characters, never empty.
func CleanMemberLabel(s string) string {
	s = CleanGuideName(s)
	if r := []rune(s); len(r) > maxMemberGrantLabelRune {
		s = strings.TrimSpace(string(r[:maxMemberGrantLabelRune]))
	}
	return s
}

// CreateMemberGrant writes a grant and its audit row in one transaction. The caller is the Operator's own route; no other code calls it. It refuses a board that is not there, a malformed link or
// person, a level that is not one of the two, an expiry past MemberGrantMaxDays, a second live grant for the same person on the same board, and the per-board and per-person ceilings.
func (s *Store) CreateMemberGrant(ctx context.Context, in NewMemberGrant) (*MemberGrant, error) {
	if !memberLinkRe.MatchString(in.LinkID) {
		return nil, memberErr("the Hub link is not a link id")
	}
	if !memberUserRe.MatchString(in.HubUser) {
		return nil, memberErr("the person is not a Hub person label (hub-user- and 8 hex digits)")
	}
	if in.Level != MemberLevelView && in.Level != MemberLevelTeam {
		return nil, memberErr("the level is view or team")
	}
	label := CleanMemberLabel(in.Label)
	if label == "" {
		return nil, memberErr("give the person a name you will know them by")
	}
	days := in.Days
	if days == 0 {
		days = MemberGrantDefaultDays
	}
	if days < 1 || days > MemberGrantMaxDays {
		return nil, memberErr("a grant lasts 1 to 30 days")
	}
	if in.BoardID == "" || strings.TrimSpace(in.BoardID) != in.BoardID || len(in.BoardID) > 200 {
		return nil, memberErr("name the team by its id")
	}
	ok, err := s.BoardExists(ctx, in.BoardID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, memberErr("there is no team with that id on this computer")
	}
	now := time.Now().UTC()
	idb := make([]byte, 8)
	if _, err := rand.Read(idb); err != nil {
		return nil, err
	}
	g := MemberGrant{GrantID: "mg-" + hex.EncodeToString(idb), LinkID: in.LinkID, HubUser: in.HubUser, BoardID: in.BoardID, Level: in.Level, Label: label,
		CreatedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Duration(days) * 24 * time.Hour).Format(time.RFC3339)}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var n int
	live := `revoked_at IS NULL AND expires_at > ?`
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE link_id = ? AND hub_user = ? AND board_id = ? AND `+live, in.LinkID, in.HubUser, in.BoardID, g.CreatedAt); err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, memberErr("this person already has access to that team: revoke it first to change it")
	}
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE board_id = ? AND `+live, in.BoardID, g.CreatedAt); err != nil {
		return nil, err
	}
	if n >= MemberGrantsPerBoard {
		return nil, memberErr("that team already has as many people with access as Coral allows")
	}
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE link_id = ? AND hub_user = ? AND `+live, in.LinkID, in.HubUser, g.CreatedAt); err != nil {
		return nil, err
	}
	if n >= MemberGrantsPerPerson {
		return nil, memberErr("this person already has access to as many teams as Coral allows")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO member_grant (grant_id, link_id, hub_user, board_id, level, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		g.GrantID, g.LinkID, g.HubUser, g.BoardID, g.Level, g.Label, g.CreatedAt, g.ExpiresAt); err != nil {
		return nil, err
	}
	if err := memberAudit(ctx, tx, "granted", g); err != nil {
		return nil, err
	}
	return &g, tx.Commit()
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func memberAudit(ctx context.Context, tx execer, event string, g MemberGrant) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO member_grant_audit (at, grant_id, event, link_id, hub_user, board_id, level) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		nowUTC(), g.GrantID, event, g.LinkID, g.HubUser, g.BoardID, g.Level)
	return err
}

// MemberGrantLive is the live grant of a person on a board: not revoked, not expired, read from the table now. ErrNoMemberGrant when there is none; any other error is a store failure the caller
// refuses on. Every member call reads it; nothing keeps its answer.
func (s *Store) MemberGrantLive(ctx context.Context, linkID, hubUser, boardID string, now time.Time) (*MemberGrant, error) {
	var g MemberGrant
	err := s.db.GetContext(ctx, &g, `SELECT grant_id, link_id, hub_user, board_id, level, label, created_at, expires_at, revoked_at FROM member_grant
		WHERE link_id = ? AND hub_user = ? AND board_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`, linkID, hubUser, boardID, now.UTC().Format(time.RFC3339))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoMemberGrant
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// ListMemberGrants is the live grants of a board (or of every board when board is ""), newest first.
func (s *Store) ListMemberGrants(ctx context.Context, board string, now time.Time) ([]MemberGrant, error) {
	out := []MemberGrant{}
	q := `SELECT grant_id, link_id, hub_user, board_id, level, label, created_at, expires_at, revoked_at FROM member_grant WHERE revoked_at IS NULL AND expires_at > ?`
	args := []any{now.UTC().Format(time.RFC3339)}
	if board != "" {
		q += ` AND board_id = ?`
		args = append(args, board)
	}
	err := s.db.SelectContext(ctx, &out, q+` ORDER BY created_at DESC, grant_id`, args...)
	return out, err
}

// RevokeMemberGrant ends a grant now. It is immediate: the next MemberGrantLive finds none. A grant that is not live is ErrNoMemberGrant.
func (s *Store) RevokeMemberGrant(ctx context.Context, grantID string, now time.Time) (*MemberGrant, error) {
	if !memberIDRe.MatchString(grantID) {
		return nil, ErrNoMemberGrant
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var g MemberGrant
	ts := now.UTC().Format(time.RFC3339)
	err = tx.GetContext(ctx, &g, `SELECT grant_id, link_id, hub_user, board_id, level, label, created_at, expires_at, revoked_at FROM member_grant WHERE grant_id = ? AND revoked_at IS NULL AND expires_at > ?`, grantID, ts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoMemberGrant
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE member_grant SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`, ts, grantID); err != nil {
		return nil, err
	}
	if err := memberAudit(ctx, tx, "revoked", g); err != nil {
		return nil, err
	}
	g.RevokedAt = &ts
	return &g, tx.Commit()
}

// RevokeMemberGrantsOfLink ends every live grant that came through a link (the link was removed or its Hub revoked): a grant never outlives the link it names.
func (s *Store) RevokeMemberGrantsOfLink(ctx context.Context, linkID string, now time.Time) (int, error) {
	gs := []MemberGrant{}
	ts := now.UTC().Format(time.RFC3339)
	if err := s.db.SelectContext(ctx, &gs, `SELECT grant_id, link_id, hub_user, board_id, level, label, created_at, expires_at, revoked_at FROM member_grant WHERE link_id = ? AND revoked_at IS NULL AND expires_at > ?`, linkID, ts); err != nil {
		return 0, err
	}
	n := 0
	for _, g := range gs {
		if _, err := s.RevokeMemberGrant(ctx, g.GrantID, now); err == nil {
			n++
		} else if !errors.Is(err, ErrNoMemberGrant) {
			return n, err
		}
	}
	return n, nil
}

// MemberGrantAuditCount is how many audit rows a grant has (for tests).
func (s *Store) MemberGrantAuditCount(ctx context.Context, grantID string) (int, error) {
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant_audit WHERE grant_id = ?`, grantID)
	return n, err
}
