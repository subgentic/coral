package board

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20899 (Security's SHOULD on #20883): a link may hold only so many live grants made through a Hub, and make only so many in an hour, so a Hub (or a stolen owner device) cannot fill the computer with access. A grant made at this computer is not
// counted by either cap.

func hubGrant(person int, link string) NewMemberGrant {
	g := grantOf("team1")
	g.LinkID = link
	g.HubUser = fmt.Sprintf("hub-user-%08x", person)
	g.ViaHub = true
	return g
}

func TestALinkMakesOnlySoManyGrantsThroughAHubInAnHour(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	for i := 0; i < MemberRelayedPerLinkPerHour; i++ {
		_, err := s.CreateMemberGrant(ctx, hubGrant(i, mgLink))
		require.NoError(t, err, "grant %d", i)
	}
	_, err := s.CreateMemberGrant(ctx, hubGrant(99, mgLink))
	require.ErrorIs(t, err, ErrMemberGrant)
	assert.Contains(t, err.Error(), "too many")
	// Another link is not held back, and neither is a grant made here.
	_, err = s.CreateMemberGrant(ctx, hubGrant(99, "lnk-cccc3333"))
	assert.NoError(t, err)
	local := grantOf("team1")
	local.HubUser = "hub-user-0000ffff"
	_, err = s.CreateMemberGrant(ctx, local)
	assert.NoError(t, err)
	// Revoking does not give the hour back: the count is of grants made.
	gs, err := s.ListMemberGrants(ctx, "team1", time.Now())
	require.NoError(t, err)
	for _, g := range gs {
		if g.ViaHub && g.LinkID == mgLink {
			_, _ = s.RevokeMemberGrant(ctx, g.GrantID, time.Now())
		}
	}
	_, err = s.CreateMemberGrant(ctx, hubGrant(100, mgLink))
	assert.ErrorIs(t, err, ErrMemberGrant, "revoked grants still count for the hour")
}

func TestALinkHoldsOnlySoManyLiveGrantsMadeThroughAHub(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	for i := 0; i < MemberRelayedLivePerLink; i++ {
		_, err := s.CreateMemberGrant(ctx, hubGrant(i, mgLink))
		require.NoError(t, err, "grant %d", i)
		// Age each one past the hour so only the live cap is in play.
		_, err = s.db.ExecContext(ctx, `UPDATE member_grant SET created_at = ? WHERE link_id = ?`, time.Now().Add(-2*time.Hour).UTC().Format(time.RFC3339), mgLink)
		require.NoError(t, err)
	}
	_, err := s.CreateMemberGrant(ctx, hubGrant(200, mgLink))
	require.ErrorIs(t, err, ErrMemberGrant)
	assert.Contains(t, err.Error(), "already holds as many")
	_, err = s.CreateMemberGrant(ctx, hubGrant(200, "lnk-cccc3333"))
	assert.NoError(t, err, "another link has its own count")
}

// Removing an owner device can end what it signed.
func TestGrantsSignedByADeviceCanBeCountedAndEndedWithIt(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		_, err := s.CreateMemberGrant(ctx, hubGrant(i, mgLink))
		require.NoError(t, err)
	}
	n, err := s.CountLiveGrantsSignedBy(ctx, mgSigner, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 2, n)
	n, err = s.CountLiveGrantsSignedBy(ctx, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", time.Now())
	require.NoError(t, err)
	assert.Equal(t, 0, n)
	ended, err := s.RevokeMemberGrantsSignedBy(ctx, mgSigner, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 2, ended)
	n, _ = s.CountLiveGrantsSignedBy(ctx, mgSigner, time.Now())
	assert.Equal(t, 0, n)
	g, err := s.MemberGrantByID(ctx, mustFirstGrantID(t, s))
	require.NoError(t, err)
	assert.Equal(t, MemberRevokedDeviceGone, g.RevokedBy)
}

func mustFirstGrantID(t *testing.T, s *Store) string {
	var id string
	require.NoError(t, s.db.GetContext(context.Background(), &id, `SELECT grant_id FROM member_grant LIMIT 1`))
	return id
}
