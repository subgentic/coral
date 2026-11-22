package routes

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #20581 (d): a live Full grant is a standing Needs you item that names the person and the end, a view grant is not one, and the item goes when the grant is revoked or ends.
func TestALiveFullGrantIsAStandingNeedsYouItemUntilItEnds(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	_, err = bs.Subscribe(ctx, "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	now := time.Now()
	mk := func(user, level string, nonce string) *board.MemberGrant {
		g := board.NewMemberGrant{LinkID: "lnk-aaaa1111", HubUser: user, Level: level, Label: "Ada from Acme", Days: 7,
			SignedBy: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Nonce: nonce, Ts: now.Unix()}
		if level == board.MemberLevelFull {
			g.ScopeKind = board.MemberScopeComputer
		} else {
			g.ScopeKind, g.ScopeID, g.BoardID = board.MemberScopeBoard, "team1", "team1"
		}
		got, err := bs.CreateMemberGrant(ctx, g)
		require.NoError(t, err)
		return got
	}
	clock := now
	list := MemberGrantNoticeItems(bs, func() time.Time { return clock })

	items, err := list(ctx)
	require.NoError(t, err)
	assert.Empty(t, items, "no grants, no items")

	mk("hub-user-bbbb2222", board.MemberLevelView, "0000000000000000000001")
	items, _ = list(ctx)
	assert.Empty(t, items, "a view grant is not a Full grant")

	full := mk("hub-user-cccc3333", board.MemberLevelFull, "0000000000000000000002")
	items, err = list(ctx)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "member_full", items[0].Kind)
	assert.Equal(t, "member_full:"+full.GrantID, items[0].ID)
	assert.Contains(t, items[0].Line, "hub-user-cccc3333")
	assert.Contains(t, items[0].Line, "Ada from Acme")
	assert.Contains(t, items[0].Line, "run commands")
	assert.Contains(t, items[0].Line, needsYouTime(full.ExpiresAt), "it says when it ends")

	clock = now.Add(2 * time.Hour)
	items, _ = list(ctx)
	assert.Len(t, items, 1, "still there while it is live, not only for a day")

	_, err = bs.RevokeMemberGrant(ctx, full.GrantID, clock)
	require.NoError(t, err)
	items, _ = list(ctx)
	assert.Empty(t, items, "revoked: gone")

	full2 := mk("hub-user-dddd4444", board.MemberLevelFull, "0000000000000000000003")
	clock = time.Now().Add(8 * 24 * time.Hour)
	items, _ = list(ctx)
	assert.Empty(t, items, "expired: gone (%s)", full2.ExpiresAt)
}

// #20590 (4): the first request a live grant lets through is written once to the audit and shows in Needs you for a day; a second request adds nothing.
func TestTheFirstUseOfAGrantIsRecordedOnceAndShownInNeedsYou(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	_, err = bs.Subscribe(ctx, "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	g, err := bs.CreateMemberGrant(ctx, board.NewMemberGrant{LinkID: "lnk-aaaa1111", HubUser: "hub-user-bbbb2222", Level: board.MemberLevelView, ScopeKind: board.MemberScopeBoard, ScopeID: "team1", BoardID: "team1",
		Label: "Ada", Days: 7, SignedBy: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Nonce: "0000000000000000000009", Ts: time.Now().Unix()})
	require.NoError(t, err)
	clock := time.Now()
	list := MemberGrantNoticeItems(bs, func() time.Time { return clock })

	items, _ := list(ctx)
	assert.Empty(t, items, "granted but not yet used: nothing to tell")

	first, err := bs.NoteMemberGrantFirstUse(ctx, *g)
	require.NoError(t, err)
	assert.True(t, first)
	first, err = bs.NoteMemberGrantFirstUse(ctx, *g)
	require.NoError(t, err)
	assert.False(t, first, "recorded once per grant")

	items, err = list(ctx)
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "member_first_use", items[0].Kind)
	assert.Equal(t, "member_first_use:"+g.GrantID, items[0].ID)
	assert.Contains(t, items[0].Line, "hub-user-bbbb2222")
	assert.Contains(t, items[0].Line, "team1")

	clock = clock.Add(25 * time.Hour)
	items, _ = list(ctx)
	assert.Empty(t, items, "a day later it is no longer shown")
}
