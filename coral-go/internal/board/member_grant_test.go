package board

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	mgLink = "lnk-aaaa1111"
	mgUser = "hub-user-bbbb2222"
)

func memberStore(t *testing.T) *Store {
	s := testStore(t)
	_, err := s.Subscribe(context.Background(), "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	return s
}

func grantOf(board string) NewMemberGrant {
	return NewMemberGrant{LinkID: mgLink, HubUser: mgUser, BoardID: board, Level: MemberLevelTeam, Label: "Ada from Acme"}
}

// #20387 S1: a grant is keyed by the link and the Hub person, names one board by id, and is read from the table on every call.
func TestAMemberGrantIsKeyedByLinkPersonAndBoardAndReadEveryTime(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	now := time.Now()
	_, err := s.MemberGrantLive(ctx, mgLink, mgUser, "team1", now)
	assert.ErrorIs(t, err, ErrNoMemberGrant)

	g, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	live, err := s.MemberGrantLive(ctx, mgLink, mgUser, "team1", now)
	require.NoError(t, err)
	assert.Equal(t, g.GrantID, live.GrantID)
	assert.Equal(t, MemberLevelTeam, live.Level)

	// The pair is the key: the same person through another link, another person, another board: none.
	for _, k := range [][3]string{{"lnk-cccc3333", mgUser, "team1"}, {mgLink, "hub-user-dddd4444", "team1"}, {mgLink, mgUser, "team2"}} {
		_, err := s.MemberGrantLive(ctx, k[0], k[1], k[2], now)
		assert.ErrorIs(t, err, ErrNoMemberGrant, "%v", k)
	}

	// A revoke between two reads: the second finds none (no cache).
	_, err = s.RevokeMemberGrant(ctx, g.GrantID, now)
	require.NoError(t, err)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, "team1", now)
	assert.ErrorIs(t, err, ErrNoMemberGrant)
	_, err = s.RevokeMemberGrant(ctx, g.GrantID, now)
	assert.ErrorIs(t, err, ErrNoMemberGrant, "a second revoke finds nothing live")
}

func TestAMemberGrantExpires(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	in := grantOf("team1")
	in.Days = 1
	_, err := s.CreateMemberGrant(ctx, in)
	require.NoError(t, err)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, "team1", time.Now().Add(23*time.Hour))
	assert.NoError(t, err)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, "team1", time.Now().Add(25*time.Hour))
	assert.ErrorIs(t, err, ErrNoMemberGrant, "past its expiry it is not live")
}

func TestAMemberGrantIsRefusedWhenItIsNotValid(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	bad := map[string]func(*NewMemberGrant){
		"no expiry beyond 30 days":  func(g *NewMemberGrant) { g.Days = 31 },
		"negative days":             func(g *NewMemberGrant) { g.Days = -1 },
		"a level that is not one":   func(g *NewMemberGrant) { g.Level = "owner" },
		"a level of guide":          func(g *NewMemberGrant) { g.Level = "guide" },
		"a board that is not there": func(g *NewMemberGrant) { g.BoardID = "no-such-team" },
		"a board name with spaces":  func(g *NewMemberGrant) { g.BoardID = " team1" },
		"a link that is not a link": func(g *NewMemberGrant) { g.LinkID = "lnk-1" },
		"a person that is not one":  func(g *NewMemberGrant) { g.HubUser = "Operator" },
		"no label":                  func(g *NewMemberGrant) { g.Label = "  " },
		"the Operator's name":       func(g *NewMemberGrant) { g.Label = "Operator" },
	}
	for name, f := range bad {
		in := grantOf("team1")
		f(&in)
		_, err := s.CreateMemberGrant(ctx, in)
		require.Error(t, err, name)
		assert.True(t, errors.Is(err, ErrMemberGrant) || err != nil, name)
	}
	ls, err := s.ListMemberGrants(ctx, "", time.Now())
	require.NoError(t, err)
	assert.Empty(t, ls, "a refused grant writes no row")
}

func TestMemberGrantCeilings(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	_, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	_, err = s.CreateMemberGrant(ctx, grantOf("team1"))
	assert.ErrorIs(t, err, ErrMemberGrant, "a second live grant for the same person and board")

	// Per person: five boards.
	for i := 2; i <= MemberGrantsPerPerson; i++ {
		b := "team" + string(rune('0'+i))
		_, err := s.Subscribe(ctx, b, "Dev", "Backend Dev", "s"+b, nil, "")
		require.NoError(t, err)
		_, err = s.CreateMemberGrant(ctx, grantOf(b))
		require.NoError(t, err, b)
	}
	_, err = s.Subscribe(ctx, "team9", "Dev", "Backend Dev", "s9", nil, "")
	require.NoError(t, err)
	_, err = s.CreateMemberGrant(ctx, grantOf("team9"))
	assert.ErrorIs(t, err, ErrMemberGrant, "a sixth team for one person")

	// Per board: twenty people.
	s2 := memberStore(t)
	for i := 0; i < MemberGrantsPerBoard; i++ {
		in := grantOf("team1")
		in.HubUser = "hub-user-" + hex8(i)
		_, err := s2.CreateMemberGrant(ctx, in)
		require.NoError(t, err, i)
	}
	in := grantOf("team1")
	in.HubUser = "hub-user-ffffffff"
	_, err = s2.CreateMemberGrant(ctx, in)
	assert.ErrorIs(t, err, ErrMemberGrant, "a twenty-first person on one board")
}

func hex8(i int) string {
	const d = "0123456789abcdef"
	b := []byte("00000000")
	for k := 7; k >= 0 && i > 0; k-- {
		b[k] = d[i%16]
		i /= 16
	}
	return string(b)
}

// The audit has no text field: nothing a person wrote is kept in it; a grant and a revoke each write one row.
func TestTheMemberGrantAuditHasNoTextField(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	g, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	_, err = s.RevokeMemberGrant(ctx, g.GrantID, time.Now())
	require.NoError(t, err)
	n, err := s.MemberGrantAuditCount(ctx, g.GrantID)
	require.NoError(t, err)
	assert.Equal(t, 2, n)
	rows, err := s.db.QueryxContext(ctx, `SELECT * FROM member_grant_audit`)
	require.NoError(t, err)
	cols, _ := rows.Columns()
	rows.Close()
	assert.Equal(t, []string{"id", "at", "grant_id", "event", "link_id", "hub_user", "board_id", "level"}, cols, "no label, no text, no free field")
}

func TestRemovingALinkEndsItsGrants(t *testing.T) {
	s := memberStore(t)
	ctx := context.Background()
	_, err := s.CreateMemberGrant(ctx, grantOf("team1"))
	require.NoError(t, err)
	n, err := s.RevokeMemberGrantsOfLink(ctx, mgLink, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	_, err = s.MemberGrantLive(ctx, mgLink, mgUser, "team1", time.Now())
	assert.ErrorIs(t, err, ErrNoMemberGrant)
}
