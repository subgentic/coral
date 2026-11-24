package board

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The member grant (#20387 S1, reshaped by #20511 to the two levels of Hub sharing): what a Hub person may do on this computer, held here. It is written only after the owner's own device has signed it
// (MemberGrantDigest) and never by a Hub or an agent; it is keyed by the link and the Hub person the connector stamped. The Hub never holds the authority: it names a person, and this table says what that person may
// do. Reads of it are made on every call, never cached.
//
// Two levels. "view" reads ONE scope (a team's board, or one agent), with optional add-ons for its artifacts and its files. "full" is the whole computer and has no scope and no add-ons. Every grant
// expires: view in at most 30 days, full in at most 7.
const (
	MemberLevelView = "view"
	MemberLevelFull = "full"
)

// Scope kinds: a view grant names a board or an agent; a full grant names the computer.
const (
	MemberScopeBoard    = "board"
	MemberScopeAgent    = "agent"
	MemberScopeComputer = "computer"
)

// The gates. Full access is a remote shell on the computer and the add-ons and the agent scope each need their own slice and its own read: until a commit says otherwise, nothing can be granted for them.
// Each changes only in a commit Security has read (B8, V5, V9). The store checks the variables below, which equal the constants unless a test opened them (AllowMemberGatesForTest).
const (
	MemberFullOpen       = false // a full grant
	MemberAgentScopeOpen = false // a view grant for one agent (its identity across a resume is not traced yet)
	MemberFilesOpen      = false // the files add-on (a pinned folder, safefs reads)
)

var (
	memberFullOpen       = MemberFullOpen
	memberAgentScopeOpen = MemberAgentScopeOpen
	memberFilesOpen      = MemberFilesOpen
	memberGatesMu        sync.Mutex
)

// AllowMemberGatesForTest opens the three gates for one test and shuts them when it ends. Nothing but a test calls it; tests that use it do not run in parallel with each other (the gates are package variables,
// and a second one waits for the lock).
func AllowMemberGatesForTest(t interface{ Cleanup(func()) }) {
	memberGatesMu.Lock()
	memberFullOpen, memberAgentScopeOpen, memberFilesOpen = true, true, true
	t.Cleanup(func() {
		memberFullOpen, memberAgentScopeOpen, memberFilesOpen = MemberFullOpen, MemberAgentScopeOpen, MemberFilesOpen
		memberGatesMu.Unlock()
	})
}

// Bounds on a grant.
const (
	MemberViewMaxDays      = 30 // the longest a view grant lives
	MemberFullMaxDays      = 7  // the longest a full grant lives
	MemberGrantDefaultDays = 7
	MemberGrantsPerScope   = 20 // live grants on one board or agent
	MemberGrantsPerPerson  = 5  // live grants for one (link, Hub person)
	MemberFullPerComputer  = 3  // live full grants on this computer
	// What one link may do through a Hub (#20899, Security's SHOULD on #20883): hold this many live grants made through a Hub, and make this many in an hour (revoked ones still count). A grant made at this computer is in neither.
	MemberRelayedLivePerLink    = 15
	MemberRelayedPerLinkPerHour = 10
	maxMemberGrantLabelRune     = 40
	maxMemberScopeID            = 200
)

var (
	// ErrMemberGrant is a grant that cannot be made: the message says why in plain words.
	ErrMemberGrant = errors.New("the member grant is not valid")
	// ErrNoMemberGrant is a grant that is not there (or not live).
	ErrNoMemberGrant = errors.New("no such member grant")

	memberLinkRe = regexp.MustCompile(`^lnk-[0-9a-f]{8}$`)
	memberUserRe = regexp.MustCompile(`^hub-user-[0-9a-f]{8}$`)
	memberIDRe   = regexp.MustCompile(`^mg-[0-9a-f]{16}$`)
	memberKIDRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	memberNonce  = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
)

// MemberGrant is one row.
type MemberGrant struct {
	GrantID       string  `db:"grant_id" json:"grant_id"`
	LinkID        string  `db:"link_id" json:"link_id"`
	HubUser       string  `db:"hub_user" json:"hub_user"`
	Level         string  `db:"level" json:"level"`
	ScopeKind     string  `db:"scope_kind" json:"scope_kind"`
	ScopeID       string  `db:"scope_id" json:"scope_id"`
	BoardID       string  `db:"board_id" json:"board_id"` // the board of a board or agent scope; empty for the computer
	FlagArtifacts bool    `db:"flag_artifacts" json:"artifacts"`
	FlagFiles     bool    `db:"flag_files" json:"files"`
	PinnedFolder  string  `db:"pinned_folder" json:"pinned_folder,omitempty"`
	Label         string  `db:"label" json:"label"`
	SignedBy      string  `db:"signed_by" json:"signed_by"` // the owner's device that signed it
	CreatedAt     string  `db:"created_at" json:"created_at"`
	ExpiresAt     string  `db:"expires_at" json:"expires_at"`
	RevokedAt     *string `db:"revoked_at" json:"revoked_at,omitempty"`
	ViaHub        bool    `db:"via_hub" json:"via_hub"`       // made by the owner's device through a Hub (#20914), not at this computer
	RevokedBy     string  `db:"revoked_by" json:"revoked_by"` // what ended it: this computer, signed device, link removed; empty while live or expired
}

const memberGrantCols = `grant_id, link_id, hub_user, level, scope_kind, scope_id, board_id, flag_artifacts, flag_files, pinned_folder, label, signed_by, created_at, expires_at, revoked_at, via_hub, revoked_by`

// NewMemberGrant is what the owner's device signed. SignedBy, Nonce and Ts are the proof: a grant without them is never written, and a nonce is spent once.
type NewMemberGrant struct {
	LinkID        string
	HubUser       string
	Level         string
	ScopeKind     string
	ScopeID       string // the board's id, or the agent's stable record id; empty for the computer
	BoardID       string // the board of the scope (the agent's board for an agent scope); empty for the computer
	FlagArtifacts bool
	FlagFiles     bool
	PinnedFolder  string
	Label         string
	Days          int // 0 is MemberGrantDefaultDays
	SignedBy      string
	Nonce         string
	Ts            int64
	ViaHub        bool // the request came through a Hub (#20914)
}

// MemberGrantDigest is the text the owner's device signs: every field of the grant in one fixed order, behind a label no other protocol uses, so a signature made for a message of another kind (or for another
// grant) is never a grant. The label of the person and the proof (the signer, the signature) are not in it; the nonce and the time are.
func MemberGrantDigest(in NewMemberGrant) []byte {
	days := in.Days
	if days == 0 {
		days = MemberGrantDefaultDays
	}
	b2i := func(b bool) string {
		if b {
			return "1"
		}
		return "0"
	}
	return []byte(strings.Join([]string{"coral/member-grant/1", in.LinkID, in.HubUser, in.Level, in.ScopeKind, in.ScopeID, in.BoardID, b2i(in.FlagArtifacts), b2i(in.FlagFiles),
		in.PinnedFolder, fmt.Sprint(days), in.Nonce, fmt.Sprint(in.Ts)}, "\n"))
}

func (s *Store) ensureMemberGrantSchema(ctx context.Context) error {
	// The first shape of this table (#20387, level view or team, one board, no proof) never reached a release. A table of that shape is dropped: its rows are not mapped to anything (a team grant is never a
	// full one), and none can exist outside a development database.
	var hasScope int
	var hasTable int
	if err := s.db.GetContext(ctx, &hasTable, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='member_grant'`); err != nil {
		return err
	}
	if hasTable > 0 {
		if err := s.db.GetContext(ctx, &hasScope, `SELECT COUNT(*) FROM pragma_table_info('member_grant') WHERE name='signed_nonce'`); err != nil {
			return err
		}
		if hasScope == 0 {
			if _, err := s.db.ExecContext(ctx, `DROP TABLE member_grant`); err != nil {
				return err
			}
			if _, err := s.db.ExecContext(ctx, `DROP TABLE IF EXISTS member_grant_audit`); err != nil {
				return err
			}
		}
	}
	for _, ddl := range []string{
		// The checks are the model, not the code's good manners (B5): a view grant has a board or an agent scope with a non-empty id and a board; a full grant has the computer, no id, no board, no add-ons;
		// the add-ons belong to view only, and a files add-on pins a folder.
		`CREATE TABLE IF NOT EXISTS member_grant (
			grant_id       TEXT PRIMARY KEY,
			link_id        TEXT NOT NULL,
			hub_user       TEXT NOT NULL,
			level          TEXT NOT NULL CHECK (level IN ('view', 'full')),
			scope_kind     TEXT NOT NULL CHECK (scope_kind IN ('board', 'agent', 'computer')),
			scope_id       TEXT NOT NULL,
			board_id       TEXT NOT NULL,
			flag_artifacts INTEGER NOT NULL DEFAULT 0 CHECK (flag_artifacts IN (0, 1)),
			flag_files     INTEGER NOT NULL DEFAULT 0 CHECK (flag_files IN (0, 1)),
			pinned_folder  TEXT NOT NULL DEFAULT '',
			label          TEXT NOT NULL,
			signed_by      TEXT NOT NULL CHECK (length(signed_by) = 43),
			signed_nonce   TEXT NOT NULL UNIQUE CHECK (length(signed_nonce) = 22),
			signed_digest  TEXT NOT NULL CHECK (length(signed_digest) = 64),
			created_at     TEXT NOT NULL,
			expires_at     TEXT NOT NULL,
			revoked_at     TEXT,
			via_hub        INTEGER NOT NULL DEFAULT 0,
			revoked_by     TEXT NOT NULL DEFAULT '',
			CHECK (
				(level = 'view' AND scope_kind IN ('board', 'agent') AND scope_id <> '' AND board_id <> '' AND (scope_kind <> 'board' OR scope_id = board_id))
				OR (level = 'full' AND scope_kind = 'computer' AND scope_id = '' AND board_id = '' AND flag_artifacts = 0 AND flag_files = 0)
			),
			CHECK (flag_files = 0 OR pinned_folder <> ''),
			CHECK (pinned_folder = '' OR flag_files = 1)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_member_grant_pair ON member_grant(link_id, hub_user, scope_kind, scope_id)`,
		// The audit of grants: who was given what, signed by which device, and what ended it. There is no text field: nothing a person wrote is kept here.
		`CREATE TABLE IF NOT EXISTS member_grant_audit (
			id        INTEGER PRIMARY KEY AUTOINCREMENT,
			at        TEXT NOT NULL,
			grant_id  TEXT NOT NULL,
			event     TEXT NOT NULL,
			link_id   TEXT NOT NULL,
			hub_user  TEXT NOT NULL,
			level     TEXT NOT NULL,
			scope_kind TEXT NOT NULL,
			scope_id  TEXT NOT NULL,
			board_id  TEXT NOT NULL,
			signed_by TEXT NOT NULL
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, ddl); err != nil {
			return err
		}
	}
	// A table made before the notice feed (#20914) gets its two columns.
	for _, col := range []struct{ name, ddl string }{
		{"via_hub", `ALTER TABLE member_grant ADD COLUMN via_hub INTEGER NOT NULL DEFAULT 0`},
		{"revoked_by", `ALTER TABLE member_grant ADD COLUMN revoked_by TEXT NOT NULL DEFAULT ''`},
	} {
		var has int
		if err := s.db.GetContext(ctx, &has, `SELECT COUNT(*) FROM pragma_table_info('member_grant') WHERE name = ?`, col.name); err != nil {
			return err
		}
		if has == 0 {
			if _, err := s.db.ExecContext(ctx, col.ddl); err != nil {
				return err
			}
		}
	}
	return nil
}

func memberErr(why string) error { return errors.Join(ErrMemberGrant, errors.New(why)) }

// CleanMemberLabel is the label as it may be stored: one cleaned line the owner typed, at most maxMemberGrantLabelRune characters, never empty.
func CleanMemberLabel(s string) string {
	s = CleanGuideName(s)
	if r := []rune(s); len(r) > maxMemberGrantLabelRune {
		s = strings.TrimSpace(string(r[:maxMemberGrantLabelRune]))
	}
	return s
}

// CreateMemberGrant writes a grant and its audit row in one transaction. The caller is the owner's own signed route; no other code calls it. It refuses a grant with no proof of the owner's device, a
// level or scope that is not one of the two models, a gate that is shut (MemberFullOpen, MemberAgentScopeOpen, MemberFilesOpen), an expiry past the level's bound, a board that is not there, a second live
// grant of the same person for the same scope, and the ceilings (per scope, per person, and live full grants on the computer).
func (s *Store) CreateMemberGrant(ctx context.Context, in NewMemberGrant) (*MemberGrant, error) {
	if !memberKIDRe.MatchString(in.SignedBy) || !memberNonce.MatchString(in.Nonce) || in.Ts <= 0 {
		return nil, memberErr("access is given only with the signature of your own device")
	}
	if !memberLinkRe.MatchString(in.LinkID) {
		return nil, memberErr("the Hub link is not a link id")
	}
	if !memberUserRe.MatchString(in.HubUser) {
		return nil, memberErr("the person is not a Hub person label (hub-user- and 8 hex digits)")
	}
	label := CleanMemberLabel(in.Label)
	if label == "" {
		return nil, memberErr("give the person a name you will know them by")
	}
	maxDays := MemberViewMaxDays
	switch in.Level {
	case MemberLevelView:
		if in.ScopeKind != MemberScopeBoard && in.ScopeKind != MemberScopeAgent {
			return nil, memberErr("a view grant is for one team or one agent")
		}
		if in.ScopeKind == MemberScopeAgent && !memberAgentScopeOpen {
			return nil, memberErr("access to one agent is not available yet")
		}
		if in.ScopeID == "" || strings.TrimSpace(in.ScopeID) != in.ScopeID || len(in.ScopeID) > maxMemberScopeID {
			return nil, memberErr("name what the person may see by its id")
		}
		if in.BoardID == "" || strings.TrimSpace(in.BoardID) != in.BoardID || len(in.BoardID) > maxMemberScopeID || (in.ScopeKind == MemberScopeBoard && in.ScopeID != in.BoardID) {
			return nil, memberErr("name the team by its id")
		}
		if in.FlagFiles && !memberFilesOpen {
			return nil, memberErr("sharing files is not available yet")
		}
		if in.FlagFiles != (in.PinnedFolder != "") {
			return nil, memberErr("sharing files names the one folder it is for")
		}
		ok, err := s.BoardExists(ctx, in.BoardID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, memberErr("there is no team with that id on this computer")
		}
	case MemberLevelFull:
		if !memberFullOpen {
			return nil, memberErr("full access is not available yet")
		}
		if in.ScopeKind != MemberScopeComputer || in.ScopeID != "" || in.BoardID != "" || in.FlagArtifacts || in.FlagFiles || in.PinnedFolder != "" {
			return nil, memberErr("full access is the whole computer: it has no team, agent or add-on")
		}
		maxDays = MemberFullMaxDays
	default:
		return nil, memberErr("the level is view or full")
	}
	days := in.Days
	if days == 0 {
		days = MemberGrantDefaultDays
	}
	if days < 1 || days > maxDays {
		return nil, memberErr(fmt.Sprintf("a %s grant lasts 1 to %d days", in.Level, maxDays))
	}
	now := time.Now().UTC()
	idb := make([]byte, 8)
	if _, err := rand.Read(idb); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(MemberGrantDigest(in))
	g := MemberGrant{GrantID: "mg-" + hex.EncodeToString(idb), LinkID: in.LinkID, HubUser: in.HubUser, Level: in.Level, ScopeKind: in.ScopeKind, ScopeID: in.ScopeID, BoardID: in.BoardID,
		FlagArtifacts: in.FlagArtifacts, FlagFiles: in.FlagFiles, PinnedFolder: in.PinnedFolder, Label: label, SignedBy: in.SignedBy,
		CreatedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Duration(days) * 24 * time.Hour).Format(time.RFC3339), ViaHub: in.ViaHub}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var n int
	live := `revoked_at IS NULL AND expires_at > ?`
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE link_id = ? AND hub_user = ? AND scope_kind = ? AND scope_id = ? AND `+live, in.LinkID, in.HubUser, in.ScopeKind, in.ScopeID, g.CreatedAt); err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, memberErr("this person already has access to that: revoke it first to change it")
	}
	if in.Level == MemberLevelFull {
		if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE level = 'full' AND `+live, g.CreatedAt); err != nil {
			return nil, err
		}
		if n >= MemberFullPerComputer {
			return nil, memberErr("this computer already has as many people with full access as Coral allows")
		}
	} else {
		if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE scope_kind = ? AND scope_id = ? AND `+live, in.ScopeKind, in.ScopeID, g.CreatedAt); err != nil {
			return nil, err
		}
		if n >= MemberGrantsPerScope {
			return nil, memberErr("that already has as many people with access as Coral allows")
		}
	}
	if in.ViaHub {
		if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE via_hub = 1 AND link_id = ? AND `+live, in.LinkID, g.CreatedAt); err != nil {
			return nil, err
		}
		if n >= MemberRelayedLivePerLink {
			return nil, memberErr("this Hub link already holds as many people with access as Coral allows through a Hub: end some at this computer first")
		}
		if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE via_hub = 1 AND link_id = ? AND created_at >= ?`, in.LinkID, now.Add(-time.Hour).Format(time.RFC3339)); err != nil {
			return nil, err
		}
		if n >= MemberRelayedPerLinkPerHour {
			return nil, memberErr("this Hub link has given too many people access in the last hour: try again later")
		}
	}
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE link_id = ? AND hub_user = ? AND `+live, in.LinkID, in.HubUser, g.CreatedAt); err != nil {
		return nil, err
	}
	if n >= MemberGrantsPerPerson {
		return nil, memberErr("this person already has as much access as Coral allows")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO member_grant (grant_id, link_id, hub_user, level, scope_kind, scope_id, board_id, flag_artifacts, flag_files, pinned_folder, label, signed_by, signed_nonce, signed_digest, created_at, expires_at, via_hub)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		g.GrantID, g.LinkID, g.HubUser, g.Level, g.ScopeKind, g.ScopeID, g.BoardID, b2n(g.FlagArtifacts), b2n(g.FlagFiles), g.PinnedFolder, g.Label, g.SignedBy, in.Nonce, hex.EncodeToString(sum[:]), g.CreatedAt, g.ExpiresAt, b2n(g.ViaHub)); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, memberErr("that signature was already used")
		}
		return nil, err
	}
	if err := memberAudit(ctx, tx, "granted", g); err != nil {
		return nil, err
	}
	return &g, tx.Commit()
}

func b2n(b bool) int {
	if b {
		return 1
	}
	return 0
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func memberAudit(ctx context.Context, tx execer, event string, g MemberGrant) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO member_grant_audit (at, grant_id, event, link_id, hub_user, level, scope_kind, scope_id, board_id, signed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		nowUTC(), g.GrantID, event, g.LinkID, g.HubUser, g.Level, g.ScopeKind, g.ScopeID, g.BoardID, g.SignedBy)
	return err
}

// MemberGrantLive is the live grant of a person for one scope (kind and id; the computer's id is empty): not revoked, not expired, read from the table now. ErrNoMemberGrant when there is none; any other
// error is a store failure the caller refuses on. Every member call reads it; nothing keeps its answer.
func (s *Store) MemberGrantLive(ctx context.Context, linkID, hubUser, scopeKind, scopeID string, now time.Time) (*MemberGrant, error) {
	var g MemberGrant
	err := s.db.GetContext(ctx, &g, `SELECT `+memberGrantCols+` FROM member_grant
		WHERE link_id = ? AND hub_user = ? AND scope_kind = ? AND scope_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid LIMIT 1`, linkID, hubUser, scopeKind, scopeID, now.UTC().Format(time.RFC3339))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoMemberGrant
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// MemberGrantsOfPerson is every live grant of one person on one link, and whether the person has ever had a grant there (a revoked or expired one counts): a person the owner has granted
// and then ended is never "no grant, so as before". An error is a store failure the caller refuses on.
func (s *Store) MemberGrantsOfPerson(ctx context.Context, linkID, hubUser string, now time.Time) (live []MemberGrant, ever bool, err error) {
	live = []MemberGrant{}
	if err = s.db.SelectContext(ctx, &live, `SELECT `+memberGrantCols+` FROM member_grant WHERE link_id = ? AND hub_user = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid`,
		linkID, hubUser, now.UTC().Format(time.RFC3339)); err != nil {
		return nil, false, err
	}
	if len(live) > 0 {
		return live, true, nil
	}
	var n int
	if err = s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE link_id = ? AND hub_user = ?`, linkID, hubUser); err != nil {
		return nil, false, err
	}
	return live, n > 0, nil
}

// ListMemberGrants is the live grants of a board (its board scope and its agents' scopes), or of every scope when board is "" (the full grants too), newest first.
func (s *Store) ListMemberGrants(ctx context.Context, board string, now time.Time) ([]MemberGrant, error) {
	out := []MemberGrant{}
	q := `SELECT ` + memberGrantCols + ` FROM member_grant WHERE revoked_at IS NULL AND expires_at > ?`
	args := []any{now.UTC().Format(time.RFC3339)}
	if board != "" {
		q += ` AND board_id = ?`
		args = append(args, board)
	}
	err := s.db.SelectContext(ctx, &out, q+` ORDER BY created_at DESC, rowid`, args...)
	return out, err
}

// RevokeMemberGrant ends a grant now. It is immediate: the next MemberGrantLive finds none. A grant that is not live is ErrNoMemberGrant.
func (s *Store) RevokeMemberGrant(ctx context.Context, grantID string, now time.Time) (*MemberGrant, error) {
	return s.RevokeMemberGrantBy(ctx, grantID, now, "")
}

// Who ended a grant (MemberGrant.RevokedBy), as a closed list the notice feed shows.
const (
	MemberRevokedHere   = "this computer"
	MemberRevokedSigned = "signed device"
	MemberRevokedLink   = "link removed"
	// MemberRevokedDeviceGone is for a grant ended with the removal of the owner device that signed it (#20899).
	MemberRevokedDeviceGone = "device removed"
)

// RevokeMemberGrantBy is RevokeMemberGrant that records what ended the grant.
func (s *Store) RevokeMemberGrantBy(ctx context.Context, grantID string, now time.Time, by string) (*MemberGrant, error) {
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
	err = tx.GetContext(ctx, &g, `SELECT `+memberGrantCols+` FROM member_grant WHERE grant_id = ? AND revoked_at IS NULL AND expires_at > ?`, grantID, ts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoMemberGrant
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE member_grant SET revoked_at = ?, revoked_by = ? WHERE grant_id = ? AND revoked_at IS NULL`, ts, by, grantID); err != nil {
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
	if err := s.db.SelectContext(ctx, &gs, `SELECT `+memberGrantCols+` FROM member_grant WHERE link_id = ? AND revoked_at IS NULL AND expires_at > ?`, linkID, ts); err != nil {
		return 0, err
	}
	n := 0
	for _, g := range gs {
		if _, err := s.RevokeMemberGrantBy(ctx, g.GrantID, now, MemberRevokedLink); err == nil {
			n++
		} else if !errors.Is(err, ErrNoMemberGrant) {
			return n, err
		}
	}
	return n, nil
}

// MemberGrantNotices is every grant made since the given time, live, revoked or expired, newest first, for the notice feed (#20914); live only when liveOnly. At most limit rows.
func (s *Store) MemberGrantNotices(ctx context.Context, since, now time.Time, liveOnly bool, limit int) ([]MemberGrant, error) {
	out := []MemberGrant{}
	q := `SELECT ` + memberGrantCols + ` FROM member_grant WHERE created_at >= ?`
	args := []any{since.UTC().Format(time.RFC3339)}
	if liveOnly {
		q += ` AND revoked_at IS NULL AND expires_at > ?`
		args = append(args, now.UTC().Format(time.RFC3339))
	}
	args = append(args, limit)
	err := s.db.SelectContext(ctx, &out, q+` ORDER BY created_at DESC, rowid DESC LIMIT ?`, args...)
	return out, err
}

// MemberGrantByID is one grant by id whatever its state; ErrNoMemberGrant when there is none.
func (s *Store) MemberGrantByID(ctx context.Context, grantID string) (*MemberGrant, error) {
	if !memberIDRe.MatchString(grantID) {
		return nil, ErrNoMemberGrant
	}
	var g MemberGrant
	err := s.db.GetContext(ctx, &g, `SELECT `+memberGrantCols+` FROM member_grant WHERE grant_id = ?`, grantID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoMemberGrant
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// CountLiveGrantsSignedBy is how many live grants an owner device signed (#20899).
func (s *Store) CountLiveGrantsSignedBy(ctx context.Context, kid string, now time.Time) (int, error) {
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM member_grant WHERE signed_by = ? AND revoked_at IS NULL AND expires_at > ?`, kid, now.UTC().Format(time.RFC3339))
	return n, err
}

// RevokeMemberGrantsSignedBy ends every live grant an owner device signed, as its removal does when the person asks for it (#20899). It returns how many it ended.
func (s *Store) RevokeMemberGrantsSignedBy(ctx context.Context, kid string, now time.Time) (int, error) {
	gs := []MemberGrant{}
	if err := s.db.SelectContext(ctx, &gs, `SELECT `+memberGrantCols+` FROM member_grant WHERE signed_by = ? AND revoked_at IS NULL AND expires_at > ?`, kid, now.UTC().Format(time.RFC3339)); err != nil {
		return 0, err
	}
	n := 0
	for _, g := range gs {
		if _, err := s.RevokeMemberGrantBy(ctx, g.GrantID, now, MemberRevokedDeviceGone); err == nil {
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

// NoteMemberGrantFirstUse records, once for a grant, that the person it was given to used it (#20590 (4), Security F5): the first request that a live grant let through. It is an audit row written only when none exists for the grant, so
// a second call, or a second process, adds nothing; first says whether this call wrote it.
func (s *Store) NoteMemberGrantFirstUse(ctx context.Context, g MemberGrant) (first bool, err error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO member_grant_audit (at, grant_id, event, link_id, hub_user, level, scope_kind, scope_id, board_id, signed_by)
		SELECT ?, ?, 'first_use', ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM member_grant_audit WHERE grant_id = ? AND event = 'first_use')`,
		nowUTC(), g.GrantID, g.LinkID, g.HubUser, g.Level, g.ScopeKind, g.ScopeID, g.BoardID, g.SignedBy, g.GrantID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// MemberGrantUse is one first use of a grant, from the audit.
type MemberGrantUse struct {
	At        string `db:"at"`
	GrantID   string `db:"grant_id"`
	LinkID    string `db:"link_id"`
	HubUser   string `db:"hub_user"`
	Level     string `db:"level"`
	ScopeKind string `db:"scope_kind"`
	ScopeID   string `db:"scope_id"`
}

// MemberGrantFirstUses lists the first uses recorded at or after since, newest first.
func (s *Store) MemberGrantFirstUses(ctx context.Context, since time.Time) ([]MemberGrantUse, error) {
	out := []MemberGrantUse{}
	err := s.db.SelectContext(ctx, &out, `SELECT at, grant_id, link_id, hub_user, level, scope_kind, scope_id FROM member_grant_audit WHERE event = 'first_use' AND at >= ? ORDER BY id DESC`, since.UTC().Format(time.RFC3339))
	return out, err
}
