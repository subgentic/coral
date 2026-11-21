package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Link management at this computer (#20346, design v2 1.7, 3). Every call here is the Operator's own act at this computer: the routes and the CLI that reach them are never tunneled. Each one is keyed by link_id
// only and writes its log row in the same transaction, so one link's change never touches another link's row, token, owner pin or events.

// SecondLinkOpen is false while a second link is refused: Security's condition on #20201 is that every Hub-reachable write records its (link, Hub person) pair first (the pending list in the pair census is empty), and the
// Manager is still one connector. Lifting it is its own reviewed change; a server test fails if it is true while a write is pending.
const SecondLinkOpen = false

// secondLinkOpen is what the store checks: the constant, unless a test opened it (AllowSecondLinkForTest).
var secondLinkOpen = SecondLinkOpen

// AllowSecondLinkForTest opens the second-link gate for one test and shuts it again when the test ends. It exists so the connector's tests can hold two links before the gate is lifted for real; nothing but a test calls it.
// Tests that use it never run in parallel with each other: it takes a lock the test releases when it ends, so a second one waits, and none of them may call t.Parallel (the gate is one package variable).
func AllowSecondLinkForTest(t interface{ Cleanup(func()) }) {
	secondLinkMu.Lock()
	secondLinkOpen = true
	t.Cleanup(func() { secondLinkOpen = SecondLinkOpen; secondLinkMu.Unlock() })
}

var secondLinkMu sync.Mutex

// ErrSecondLinkNotYet is returned when a link is added while one exists and SecondLinkOpen is false.
var ErrSecondLinkNotYet = errors.New("a second Coral Hub link is not available yet: every Hub action must be recorded with its Hub first")

// ErrLinkExists is returned when a link to that Hub already exists.
var ErrLinkExists = errors.New("this computer is already linked to that Hub; remove that link first, then connect again")

// ErrTooManyLinks is returned when MaxCloudLinks links exist.
var ErrTooManyLinks = fmt.Errorf("at most %d Coral Hubs can be linked", MaxCloudLinks)

// ErrBadLinkState is returned for a change a link's state does not allow.
var ErrBadLinkState = errors.New("that link is not in a state that allows this")

// Link event actions.
const (
	LinkEventAdded        = "added"
	LinkEventCap          = "cap"
	LinkEventRemoveBegin  = "remove-begin"
	LinkEventRemoved      = "removed"
	LinkEventDropped      = "dropped"
	LinkEventTokenDeleted = "token-deleted"
)

// LinkEvent is one row of the log of link changes.
type LinkEvent struct {
	ID        int64  `json:"id" db:"id"`
	LinkID    string `json:"link_id" db:"link_id"`
	HubOrigin string `json:"hub_origin" db:"hub_origin"`
	Action    string `json:"action" db:"action"`
	Detail    string `json:"detail" db:"detail"`
	At        string `json:"at" db:"at"`
}

// CheckCanAddLink says whether another link may be added now: nil, ErrSecondLinkNotYet or ErrTooManyLinks.
func (s *CloudStore) CheckCanAddLink(ctx context.Context) error {
	var n int
	if err := s.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_link"); err != nil {
		return err
	}
	if n >= MaxCloudLinks {
		return ErrTooManyLinks
	}
	if n >= 1 && !secondLinkOpen {
		return ErrSecondLinkNotYet
	}
	return nil
}

func logLinkEvent(ctx context.Context, tx execer, linkID, origin, action, detail string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO cloud_link_event (link_id, hub_origin, action, detail, at) VALUES (?, ?, ?, ?, ?)", linkID, origin, action, detail, nowUTC())
	return err
}

// SetLinkCap sets one link's cap (view, interact or launch) and logs the change in the same transaction. The cap the live check reads for the enrollment's link (the setting cloud_max_mode) follows it. It returns the
// cap the link had. An unknown link is ErrNoCloudLink and a bad mode changes nothing.
func (s *CloudStore) SetLinkCap(ctx context.Context, linkID, mode string) (string, error) {
	if !validMode(mode) {
		return "", errors.New("the cap is view, interact or launch")
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var l struct {
		Origin string `db:"hub_origin"`
		Mode   string `db:"max_mode"`
		State  string `db:"state"`
	}
	if err := tx.GetContext(ctx, &l, "SELECT hub_origin, max_mode, state FROM cloud_link WHERE link_id = ?", linkID); errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoCloudLink
	} else if err != nil {
		return "", err
	}
	if l.State == LinkStateRemoving {
		return "", ErrBadLinkState
	}
	if _, err := tx.ExecContext(ctx, "UPDATE cloud_link SET max_mode = ? WHERE link_id = ?", mode, linkID); err != nil {
		return "", err
	}
	var src string
	if err := tx.GetContext(ctx, &src, "SELECT source FROM cloud_link WHERE link_id = ?", linkID); err != nil {
		return "", err
	}
	if src == LinkSourceEnrollment { // the enrollment's link: the live check reads the one setting, so it follows
		if _, err := tx.ExecContext(ctx, "INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", linkMaxModeKey, mode); err != nil {
			return "", err
		}
	}
	if err := logLinkEvent(ctx, tx, linkID, l.Origin, LinkEventCap, l.Mode+" -> "+mode); err != nil {
		return "", err
	}
	return l.Mode, tx.Commit()
}

// BeginRemoveLink puts one link in state removing: it has no tunnel, stream or sign-in from here on, its sealed token is kept until the Hub confirms the revoke or the removal is finished or dropped. The state it had
// is in the log row.
func (s *CloudStore) BeginRemoveLink(ctx context.Context, linkID string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var l struct {
		Origin string `db:"hub_origin"`
		State  string `db:"state"`
	}
	if err := tx.GetContext(ctx, &l, "SELECT hub_origin, state FROM cloud_link WHERE link_id = ?", linkID); errors.Is(err, sql.ErrNoRows) {
		return ErrNoCloudLink
	} else if err != nil {
		return err
	}
	if l.State == LinkStateRemoving {
		return nil // already under way: removal is idempotent
	}
	if _, err := tx.ExecContext(ctx, "UPDATE cloud_link SET state = ?, last_error = NULL WHERE link_id = ?", LinkStateRemoving, linkID); err != nil {
		return err
	}
	if err := logLinkEvent(ctx, tx, linkID, l.Origin, LinkEventRemoveBegin, "was "+l.State); err != nil {
		return err
	}
	return tx.Commit()
}

// FinishRemoveLink ends a removal: the link row and its sealed token are deleted, and the log keeps what happened. how is LinkEventRemoved (the Hub confirmed the revoke) or LinkEventDropped (the Operator dropped a
// pending removal, or the Hub's revoke could not be asked: the Hub may still list this computer). When the link is the one the old enrollment row mirrors, that row and its token go in the same transaction, so a downgrade
// cannot reconnect a removed Hub and no removed token stays at rest. Only a link in state removing can be finished.
func (s *CloudStore) FinishRemoveLink(ctx context.Context, linkID, how string) error {
	if how != LinkEventRemoved && how != LinkEventDropped {
		return errors.New("a removal ends as removed or dropped")
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var l struct {
		Origin   string `db:"hub_origin"`
		ServerID string `db:"server_id"`
		State    string `db:"state"`
	}
	if err := tx.GetContext(ctx, &l, "SELECT hub_origin, server_id, state FROM cloud_link WHERE link_id = ?", linkID); errors.Is(err, sql.ErrNoRows) {
		return ErrNoCloudLink
	} else if err != nil {
		return err
	}
	if l.State != LinkStateRemoving {
		return ErrBadLinkState
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM cloud_link WHERE link_id = ?", linkID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM link_ask_allow WHERE link_id = ?", linkID); err != nil { // what a Hub was allowed to answer goes with its link (#20413)
		return err
	}
	var hubURL string
	if err := tx.GetContext(ctx, &hubURL, "SELECT hub_url FROM cloud_connection WHERE id = 1 AND server_id = ?", l.ServerID); err == nil {
		if o, _, oerr := legacyHubOrigin(hubURL); oerr == nil && o == l.Origin {
			if _, err := tx.ExecContext(ctx, "DELETE FROM cloud_connection WHERE id = 1"); err != nil {
				return err
			}
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := logLinkEvent(ctx, tx, linkID, l.Origin, how, ""); err != nil {
		return err
	}
	return tx.Commit()
}

// ListLinkEvents returns the log of link changes, newest first, for one link or (linkID "") all of them.
func (s *CloudStore) ListLinkEvents(ctx context.Context, linkID string, limit int) ([]LinkEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var out []LinkEvent
	q := "SELECT id, link_id, hub_origin, action, detail, at FROM cloud_link_event"
	args := []any{}
	if linkID != "" {
		q += " WHERE link_id = ?"
		args = append(args, linkID)
	}
	q += " ORDER BY at DESC, id DESC LIMIT ?"
	args = append(args, limit)
	err := s.db.SelectContext(ctx, &out, q, args...)
	return out, err
}

// RemovingLink is a link whose removal the Hub has not confirmed, and when it began.
type RemovingLink struct {
	LinkID    string
	HubOrigin string
	Since     time.Time
}

// RemovingLinks lists the links in state removing, oldest first, each with the time its removal began (from the log).
func (s *CloudStore) RemovingLinks(ctx context.Context) ([]RemovingLink, error) {
	var rows []struct {
		LinkID string `db:"link_id"`
		Origin string `db:"hub_origin"`
		At     string `db:"at"`
	}
	err := s.db.SelectContext(ctx, &rows, `SELECT l.link_id, l.hub_origin, COALESCE((SELECT MAX(e.at) FROM cloud_link_event e WHERE e.link_id = l.link_id AND e.action = ?), l.created_at) AS at
		FROM cloud_link l WHERE l.state = ? ORDER BY at, l.rowid`, LinkEventRemoveBegin, LinkStateRemoving)
	if err != nil {
		return nil, err
	}
	out := make([]RemovingLink, 0, len(rows))
	for _, r := range rows {
		t, perr := time.Parse(time.RFC3339Nano, r.At)
		if perr != nil {
			t = time.Now().UTC() // an unreadable time never makes a removal look old: the token is kept
		}
		out = append(out, RemovingLink{LinkID: r.LinkID, HubOrigin: r.Origin, Since: t})
	}
	return out, nil
}

// DeleteLinkToken deletes a removing link's sealed token, so none stays at rest when the Hub never confirmed (7 days). The row stays so the Operator can drop it; a repeat does nothing.
func (s *CloudStore) DeleteLinkToken(ctx context.Context, linkID string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var l struct {
		Origin string `db:"hub_origin"`
		State  string `db:"state"`
		Token  string `db:"token"`
	}
	if err := tx.GetContext(ctx, &l, "SELECT hub_origin, state, token FROM cloud_link WHERE link_id = ?", linkID); errors.Is(err, sql.ErrNoRows) {
		return ErrNoCloudLink
	} else if err != nil {
		return err
	}
	if l.State != LinkStateRemoving {
		return ErrBadLinkState
	}
	if l.Token == "" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, "UPDATE cloud_link SET token = '' WHERE link_id = ?", linkID); err != nil {
		return err
	}
	if err := logLinkEvent(ctx, tx, linkID, l.Origin, LinkEventTokenDeleted, "the Hub did not confirm in 7 days"); err != nil {
		return err
	}
	return tx.Commit()
}

// RemovalPending reports whether a link for this server id is in state removing: the connector does not dial it.
func (s *CloudStore) RemovalPending(ctx context.Context, serverID string) bool {
	var n int
	return s.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_link WHERE server_id = ? AND state = ?", serverID, LinkStateRemoving) == nil && n > 0
}

// AddLink adds a link to a Hub at this computer (#20368): the gate (CheckCanAddLink) is checked here, in the store, so no caller can skip it. The address goes through CanonicalHubOrigin, the token is sealed under the link's own
// AAD before anything is written, the cap is the one chosen (view, interact or launch), and the link is its own record: the enrollment's save, delete and mirror never touch it. The first link is made by the enrollment, not
// here; this adds one beside it.
func (s *CloudStore) AddLink(ctx context.Context, hub, serverID, label, token, cap string) (*CloudLink, error) {
	if !validMode(cap) {
		return nil, errors.New("the cap is view, interact or launch")
	}
	origin, err := CanonicalHubOrigin(hub)
	if err != nil {
		return nil, err
	}
	if serverID == "" || token == "" {
		return nil, errors.New("a link needs the Hub's server id and token")
	}
	if err := s.CheckCanAddLink(ctx); err != nil {
		return nil, err
	}
	id, err := NewLinkID()
	if err != nil {
		return nil, err
	}
	box, err := s.rs.getBox(ctx, true, false)
	if err != nil {
		return nil, err
	}
	env, err := box.Seal(linkAAD(id), []byte(token))
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var n int
	if err := tx.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_link WHERE hub_origin = ?", origin); err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, ErrLinkExists
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, scope, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'all', ?, ?)`,
		id, origin, serverID, label, env, LinkStateActive, cap, nowUTC(), LinkSourceAdded); err != nil {
		return nil, err
	}
	if err := logLinkEvent(ctx, tx, id, origin, LinkEventAdded, "cap "+cap); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.LinkByOrigin(ctx, origin)
}

// MarkLinkRevoked records that the Hub refused this link's token: it stays listed (the person removes it), has no tunnel, and no other link is touched.
func (s *CloudStore) MarkLinkRevoked(ctx context.Context, linkID, msg string) error {
	res, err := s.db.ExecContext(ctx, "UPDATE cloud_link SET state = ?, last_error = ? WHERE link_id = ? AND state = ?", LinkStateRevoked, msg, linkID, LinkStateActive)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 && !s.linkIs(ctx, linkID) {
		return ErrNoCloudLink
	}
	return nil
}

func (s *CloudStore) linkIs(ctx context.Context, linkID string) bool {
	var n int
	return s.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_link WHERE link_id = ?", linkID) == nil && n == 1
}

// AddedLinkAt says whether a link added at this computer already has this Hub address (any spelling CanonicalHubOrigin accepts): an enrollment to it is refused before anything is asked of the Hub or written.
func (s *CloudStore) AddedLinkAt(ctx context.Context, hubURL string) bool {
	l, err := s.LinkByOrigin(ctx, hubURL)
	return err == nil && l.Source == LinkSourceAdded
}
