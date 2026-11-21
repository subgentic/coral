package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Link management at this computer (#20346, design v2 1.7, 3). Every call here is the Operator's own act at this computer: the routes and the CLI that reach them are never tunneled. Each one is keyed by link_id
// only and writes its log row in the same transaction, so one link's change never touches another link's row, token, owner pin or events.

// SecondLinkOpen is false while a second link is refused: Security's condition on #20201 is that every Hub-reachable write records its (link, Hub person) pair first (the pending list in the pair census is empty), and the
// Manager is still one connector. Lifting it is its own reviewed change; a server test fails if it is true while a write is pending.
const SecondLinkOpen = false

// ErrSecondLinkNotYet is returned when a link is added while one exists and SecondLinkOpen is false.
var ErrSecondLinkNotYet = errors.New("a second Coral Hub link is not available yet: every Hub action must be recorded with its Hub first")

// ErrTooManyLinks is returned when MaxCloudLinks links exist.
var ErrTooManyLinks = fmt.Errorf("at most %d Coral Hubs can be linked", MaxCloudLinks)

// ErrBadLinkState is returned for a change a link's state does not allow.
var ErrBadLinkState = errors.New("that link is not in a state that allows this")

// Link event actions.
const (
	LinkEventCap         = "cap"
	LinkEventRemoveBegin = "remove-begin"
	LinkEventRemoved     = "removed"
	LinkEventDropped     = "dropped"
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
	if n >= 1 && !SecondLinkOpen {
		return ErrSecondLinkNotYet
	}
	return nil
}

func logLinkEvent(ctx context.Context, tx execer, linkID, origin, action, detail string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO cloud_link_event (link_id, hub_origin, action, detail, at) VALUES (?, ?, ?, ?, ?)", linkID, origin, action, detail, nowUTC())
	return err
}

// SetLinkCap sets one link's cap (view, interact or launch) and logs the change in the same transaction. The cap the live check reads (the setting cloud_max_mode) follows it while there is one link. It returns the
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
	var n int
	if err := tx.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_link"); err != nil {
		return "", err
	}
	if n == 1 { // one link: the live check still reads the one setting, so it follows
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
