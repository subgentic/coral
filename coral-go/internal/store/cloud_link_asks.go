package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/subgentic/coral/pkg/tunnel"
)

// Which asks a Hub may answer, per link (#20413). The list applies to links ADDED here (source 'added'); the enrollment's own link keeps what it has always done (the owner answers asks through it as before),
// and that is pinned by a test. For an added link the table is empty by default: it answers no ask. Rows name a kind of the closed vocabulary (tunnel.AskKinds) and are written only by the person at this
// computer. A row for any other kind is never read as an allowance, and a row of a link that is gone is inert (every read joins the link).

var (
	// ErrAskKind is a kind that is not in the vocabulary.
	ErrAskKind = errors.New("that kind of ask cannot be answered through a Hub")
	// ErrAskListNotForLink is a link this list does not govern (the enrollment's own).
	ErrAskListNotForLink = errors.New("the list of asks a Hub may answer is for a Hub added here")
)

// LinkAskAllowed says whether a request that came through linkID may answer an ask of kind. For the enrollment's own link it is always true (unchanged). For an added link it is true only with a row, read now;
// an unknown link, a kind outside the vocabulary (tunnel.AskKindLocalOnly) and any store error are false.
func (s *CloudStore) LinkAskAllowed(ctx context.Context, linkID, kind string) (bool, error) {
	var source string
	err := s.db.GetContext(ctx, &source, `SELECT source FROM cloud_link WHERE link_id = ?`, linkID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if source != LinkSourceAdded {
		return true, nil
	}
	if !tunnel.ValidAskKind(kind) {
		return false, nil // a route that answers something no Hub may (a proposal) stays at this computer for an added link
	}
	var n int
	if err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM link_ask_allow WHERE link_id = ? AND ask_kind = ?`, linkID, kind); err != nil {
		return false, err
	}
	return n > 0, nil
}

// LinkAsksAllowed lists the kinds an added link may answer (a row of any other kind is left out), in vocabulary order.
func (s *CloudStore) LinkAsksAllowed(ctx context.Context, linkID string) ([]string, error) {
	var kinds []string
	err := s.db.SelectContext(ctx, &kinds, `SELECT a.ask_kind FROM link_ask_allow a JOIN cloud_link l ON l.link_id = a.link_id WHERE a.link_id = ? AND l.source = ?`, linkID, LinkSourceAdded)
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, k := range kinds {
		have[k] = tunnel.ValidAskKind(k)
	}
	out := []string{}
	for _, k := range tunnel.AskKinds() {
		if have[k] {
			out = append(out, k)
		}
	}
	return out, nil
}

// SetLinkAsk allows or stops one kind of ask for an added link, and logs it in the link log in the same transaction. A kind outside the vocabulary is ErrAskKind; an unknown link is ErrNoCloudLink; the
// enrollment's own link is ErrAskListNotForLink; a link being removed is ErrBadLinkState. Only the person's route calls it.
func (s *CloudStore) SetLinkAsk(ctx context.Context, linkID, kind string, allow bool) error {
	if !tunnel.ValidAskKind(kind) {
		return ErrAskKind
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var l struct {
		Origin string `db:"hub_origin"`
		State  string `db:"state"`
		Source string `db:"source"`
	}
	if err := tx.GetContext(ctx, &l, `SELECT hub_origin, state, source FROM cloud_link WHERE link_id = ?`, linkID); errors.Is(err, sql.ErrNoRows) {
		return ErrNoCloudLink
	} else if err != nil {
		return err
	}
	if l.Source != LinkSourceAdded {
		return ErrAskListNotForLink
	}
	if l.State == LinkStateRemoving {
		return ErrBadLinkState
	}
	action := "ask-stop"
	if allow {
		action = "ask-allow"
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO link_ask_allow (link_id, ask_kind, created_at) VALUES (?, ?, ?)`, linkID, kind, nowUTC())
	} else {
		_, err = tx.ExecContext(ctx, `DELETE FROM link_ask_allow WHERE link_id = ? AND ask_kind = ?`, linkID, kind)
	}
	if err != nil {
		return err
	}
	if err := logLinkEvent(ctx, tx, linkID, l.Origin, action, kind); err != nil {
		return err
	}
	return tx.Commit()
}
