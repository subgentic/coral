package store

import (
	"context"
	"database/sql"
	"errors"
)

// The owner of an added Hub's link (#20407). A link added at this computer (source 'added') has no owner until the Operator, at this computer, says who it is: by confirming the candidate the Hub named
// (ConfirmLinkOwner, "candidate"), or by the one-link, one-minute, one-shot Confirm owner (AdoptLinkOwner, "request"). A recorded label is never replaced, and the log row holds the way, never the label.

// LinkEventOwnerConfirmed is the log row of a link's owner being recorded. Its detail is "candidate" or "request": no label, no account.
const LinkEventOwnerConfirmed = "owner-confirmed"

// ErrOwnerAlreadyConfirmed is returned when the link already has an owner (it is never replaced; remove the link and add it again to change it).
var ErrOwnerAlreadyConfirmed = errors.New("this Hub link already has an owner recorded")

// LinkOwnerOf is a link's source and recorded owner label ("" when none): what the owner check reads for a request that came through that link. An unknown link is ErrNoCloudLink.
func (s *CloudStore) LinkOwnerOf(ctx context.Context, linkID string) (source, ownerUser string, err error) {
	var r struct {
		Source string `db:"source"`
		Owner  string `db:"owner_user"`
	}
	if err := s.db.GetContext(ctx, &r, "SELECT source, owner_user FROM cloud_link WHERE link_id = ?", linkID); errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNoCloudLink
	} else if err != nil {
		return "", "", err
	}
	return r.Source, r.Owner, nil
}

// ConfirmLinkOwner records account and user as the owner of an ADDED link, only when it has none, and logs it (how: "candidate" or "request") in the same transaction. The enrollment's own link keeps
// its own record (PinOwner, AdoptOwnerUser) and is refused here.
func (s *CloudStore) ConfirmLinkOwner(ctx context.Context, linkID, account, user, how string) error {
	if user == "" || (how != "candidate" && how != "request") {
		return errors.New("an owner label and how it was confirmed are needed")
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var l struct {
		Origin string `db:"hub_origin"`
		Source string `db:"source"`
		Owner  string `db:"owner_user"`
	}
	if err := tx.GetContext(ctx, &l, "SELECT hub_origin, source, owner_user FROM cloud_link WHERE link_id = ?", linkID); errors.Is(err, sql.ErrNoRows) {
		return ErrNoCloudLink
	} else if err != nil {
		return err
	}
	if l.Source != LinkSourceAdded {
		return ErrBadLinkState
	}
	res, err := tx.ExecContext(ctx, "UPDATE cloud_link SET owner_account = ?, owner_user = ?, owner_adopted_at = ? WHERE link_id = ? AND owner_user = '' AND source = ?", account, user, nowUTC(), linkID, LinkSourceAdded)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrOwnerAlreadyConfirmed
	}
	if err := logLinkEvent(ctx, tx, linkID, l.Origin, LinkEventOwnerConfirmed, how); err != nil {
		return err
	}
	return tx.Commit()
}
