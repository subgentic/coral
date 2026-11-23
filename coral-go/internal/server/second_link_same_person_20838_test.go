package server

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20838, goal #269: the same Hub person label on two Hubs is two people. Identity everywhere is the pair (link, person), so what one link's person holds is never seen by the other's, in either direction.
func TestTheSamePersonLabelOnTwoLinksSharesNoGrantOrStream(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	const linkB = "lnk-cccc3333"
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	now := time.Now()
	a := cloud.Via{LinkID: guardLink, HubUser: guardUser}
	b := cloud.Via{LinkID: linkB, HubUser: guardUser} // the same label, on another Hub

	// A grant for (A, u): the table shows it to (A, u) only.
	view, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView))
	require.NoError(t, err)
	live, ever, err := bs.MemberGrantsOfPerson(ctx, linkB, guardUser, now)
	require.NoError(t, err)
	assert.Empty(t, live, "(B, u) sees nothing of (A, u)'s grant")
	assert.False(t, ever)
	live, _, err = bs.MemberGrantsOfPerson(ctx, guardLink, guardUser, now)
	require.NoError(t, err)
	assert.Len(t, live, 1)

	// And the reverse: a grant for (B, u) is not (A, u)'s.
	gb := guardGrant(guardUser, board.MemberLevelFull)
	gb.LinkID = linkB
	_, err = bs.CreateMemberGrant(ctx, gb)
	require.NoError(t, err)
	ok, _ := memberGrantAllows(ctx, bs, cp.get, a, tunnel.TierLaunch, now, nil)
	assert.False(t, ok, "(A, u) holds a view grant: B's full grant does not raise it")
	ok, _ = memberGrantAllows(ctx, bs, cp.get, b, tunnel.TierLaunch, now, nil)
	assert.True(t, ok, "(B, u) holds its own full grant")

	// An open stream is keyed by the pair: ending A's person's streams leaves B's.
	var endedA, endedB int
	defer tunnel.RegisterOpenStream(guardLink, guardUser, tunnel.TierLaunch, "GET", "/api/sessions/live/a/terminal", func() { endedA++ })()
	defer tunnel.RegisterOpenStream(linkB, guardUser, tunnel.TierLaunch, "GET", "/api/sessions/live/a/terminal", func() { endedB++ })()
	_, err = bs.RevokeMemberGrant(ctx, view.GrantID, now)
	require.NoError(t, err)
	assert.Equal(t, 1, SweepOpenStreams(ctx, bs, cp.get, now), "only (A, u)'s stream ends: their grant ended")
	assert.Equal(t, 1, endedA)
	assert.Zero(t, endedB, "(B, u)'s stream is not touched")

	// A link ending ends its own grants only.
	n, err := bs.RevokeMemberGrantsOfLink(ctx, linkB, now)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	live, _, _ = bs.MemberGrantsOfPerson(ctx, linkB, guardUser, now)
	assert.Empty(t, live)
}

// The Operator-actions log keeps one row per pair when the same person label comes through two links; neither row names the other link.
func TestTheSamePersonLabelOnTwoLinksLeavesTwoSeparateRows(t *testing.T) {
	ctx := context.Background()
	r, cs, _, a := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	b, err := cs.AddLink(ctx, "https://hub-b.example.com", "srv_b", "Hub B", "tok-b", "launch")
	require.NoError(t, err)
	const same = "hub-user-aaaa1111"
	h := r.srv.Router()
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"launch"}`, map[string]string{"Content-Type": "application/json"}).Code)
	for _, link := range []string{a.LinkID, b.LinkID} {
		call(h, "PUT", "/api/board/team/settings", `{"subscriber_id":"Operator","cross_team_messaging":true}`,
			map[string]string{"Content-Type": "application/json", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: link, tunnel.ActorHeader: same,
				tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: same})
	}
	acts, err := r.srv.boardStore.RecentHubOperatorActions(ctx, 50)
	require.NoError(t, err)
	got := map[string]string{}
	for _, x := range acts {
		if x.Path == "/api/board/team/settings" {
			got[x.ViaLink] = x.ViaHubUser
		}
	}
	assert.Equal(t, map[string]string{a.LinkID: same, b.LinkID: same}, got, "one row for each (link, person) pair")
}
