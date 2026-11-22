package routes

import (
	"context"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// MemberGrantNoticeItems is the Needs you source of #20581 (d) and #20590 (4): the first use of each grant (below), and every live Full grant, one standing item for as long as it is live. A Full grant is a remote shell on this computer, so the owner is told in plain words who has it
// and until when, and the item goes when the grant is revoked or ends. It reads the grant table only; nothing here decides or changes a grant. The Hub person is named by the label the owner gave the grant and the
// grant's own Hub label, never by anything the Hub sent.
func MemberGrantNoticeItems(bs *board.Store, now func() time.Time) func(ctx context.Context) ([]NeedsYouItem, error) {
	return func(ctx context.Context) ([]NeedsYouItem, error) {
		if bs == nil {
			return nil, nil
		}
		grants, err := bs.ListMemberGrants(ctx, "", now())
		if err != nil {
			return nil, err
		}
		var items []NeedsYouItem
		for _, g := range grants {
			if g.Level != board.MemberLevelFull {
				continue
			}
			who := g.HubUser
			if g.Label != "" {
				who = "\"" + g.Label + "\" (" + g.HubUser + ")"
			}
			line := "Full access until " + needsYouTime(g.ExpiresAt) + ": " + who + " can use this computer as you can (run commands, change files, start agents). End it any time."
			items = append(items, NeedsYouItem{Kind: "member_full", Line: needsYouLine(line), ID: "member_full:" + g.GrantID, At: needsYouTime(g.CreatedAt)})
		}
		// And each grant's first use, for a day (#20590 (4), F5): the owner is told when the access they gave is first used.
		uses, err := bs.MemberGrantFirstUses(ctx, now().Add(-memberGrantUseNoticeWindow))
		if err != nil {
			return nil, err
		}
		for _, u := range uses {
			what := "full access to this computer"
			if u.Level != board.MemberLevelFull {
				what = "view of the \"" + u.ScopeID + "\" board's messages"
			}
			items = append(items, NeedsYouItem{Kind: "member_first_use", Line: needsYouLine(u.HubUser + " used the access you gave for the first time: " + what), ID: "member_first_use:" + u.GrantID, At: needsYouTime(u.At)})
		}
		return items, nil
	}
}

// memberGrantUseNoticeWindow is how long a first use stays in the owner's Needs you.
const memberGrantUseNoticeWindow = 24 * time.Hour
