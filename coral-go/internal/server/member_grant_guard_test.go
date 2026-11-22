package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

const (
	guardLink = "lnk-aaaa1111"
	guardUser = "hub-user-bbbb2222"
	guardKID  = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

var guardNonce atomic.Int64

func guardGrant(user, level string) board.NewMemberGrant {
	g := board.NewMemberGrant{LinkID: guardLink, HubUser: user, Level: level, Label: "Ada from Acme", Days: 7,
		SignedBy: guardKID, Nonce: fmt.Sprintf("%022d", guardNonce.Add(1)), Ts: time.Now().Unix()}
	if level == board.MemberLevelFull {
		g.ScopeKind = board.MemberScopeComputer
	} else {
		g.ScopeKind, g.ScopeID, g.BoardID = board.MemberScopeBoard, "team1", "team1"
	}
	return g
}

type guardCap struct{ m atomic.Int32 } // the link's cap now; -1 is "no active link"

func (c *guardCap) set(m tunnel.Mode) { c.m.Store(int32(m)) }
func (c *guardCap) get(context.Context, string) (tunnel.Mode, bool) {
	if v := c.m.Load(); v >= 0 {
		return tunnel.Mode(v), true
	}
	return tunnel.TierNever, false
}

func guardStore(t *testing.T) *board.Store {
	r, _, _ := linkedRemote(t, &fakeRevoker{})
	_, err := r.srv.boardStore.Subscribe(context.Background(), "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	return r.srv.boardStore
}

// S2: what a Hub person may do is the lower of the best live grant and the link's cap read now, and a person whose grants all ended gets nothing.
func TestAGrantedPersonReachesOnlyTheLowerOfTheirGrantAndTheLinksCapNow(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	v := cloud.Via{LinkID: guardLink, HubUser: guardUser}
	cp := &guardCap{}
	allow := func(need tunnel.Tier, now time.Time) (bool, string) {
		return memberGrantAllows(ctx, bs, cp.get, v, need, now)
	}
	now := time.Now()

	cp.set(tunnel.TierLaunch)
	ok, _ := allow(tunnel.TierInteract, now)
	assert.True(t, ok, "a person who never had a grant is not decided here")

	view, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView))
	require.NoError(t, err)
	ok, _ = allow(tunnel.TierView, now)
	assert.True(t, ok, "a view grant reads")
	ok, code := allow(tunnel.TierInteract, now)
	assert.False(t, ok, "a view grant does not send to an agent, whatever the link allows")
	assert.Equal(t, memberGrantLowCode, code)

	cp.set(tunnel.TierView)
	full, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelFull))
	require.NoError(t, err)
	ok, code = allow(tunnel.TierInteract, now)
	assert.False(t, ok, "a full grant on a link capped at view reaches only view")
	assert.Equal(t, memberGrantLowCode, code)
	ok, _ = allow(tunnel.TierView, now)
	assert.True(t, ok)

	cp.set(tunnel.TierInteract)
	ok, _ = allow(tunnel.TierInteract, now)
	assert.True(t, ok, "full at an interact link types into an agent")
	ok, _ = allow(tunnel.TierLaunch, now)
	assert.False(t, ok, "and does not launch: the link's cap is lower")

	cp.set(tunnel.TierLaunch)
	ok, _ = allow(tunnel.TierLaunch, now)
	assert.True(t, ok, "full is the link's cap and no more")

	ok, code = allow(tunnel.TierView, now.Add(31*24*time.Hour))
	assert.False(t, ok, "an expired grant gives nothing")
	assert.Equal(t, memberGrantEndedCode, code)

	cp.set(-1)
	ok, code = allow(tunnel.TierView, now)
	assert.False(t, ok, "a link that is removed or revoked gives nothing")
	assert.Equal(t, memberGrantEndedCode, code)

	cp.set(tunnel.TierLaunch)
	_, err = bs.RevokeMemberGrant(ctx, full.GrantID, now)
	require.NoError(t, err)
	ok, _ = allow(tunnel.TierInteract, now)
	assert.False(t, ok, "the full grant is revoked; the view one stays")
	ok, _ = allow(tunnel.TierView, now)
	assert.True(t, ok)
	_, err = bs.RevokeMemberGrant(ctx, view.GrantID, now)
	require.NoError(t, err)
	ok, code = allow(tunnel.TierView, now)
	assert.False(t, ok, "every grant ended: not 'no grant, so as before'")
	assert.Equal(t, memberGrantEndedCode, code)

	other, _ := memberGrantAllows(ctx, bs, cp.get, cloud.Via{LinkID: guardLink, HubUser: "hub-user-cccc3333"}, tunnel.TierLaunch, now)
	assert.True(t, other, "another person is not touched by this person's grants")
}

// The guard refuses a send through a link for a view grantee, lets a local request through, and an ended link's grants are ended with it.
func TestTheGuardRefusesASendForAViewGranteeAndLinkRemovalEndsTheirGrants(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	_, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView))
	require.NoError(t, err)
	hits := 0
	h := MemberGrantGuard(bs, cp.get)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	send := func(withVia bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/sessions/live/agent-1/send", nil)
		if withVia {
			req = req.WithContext(cloud.WithVia(req.Context(), cloud.Via{LinkID: guardLink, HubUser: guardUser}))
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := send(true)
	assert.Equal(t, 403, rec.Code)
	assert.Contains(t, rec.Body.String(), memberGrantLowCode)
	assert.Zero(t, hits, "the route was not reached")
	assert.Equal(t, 200, send(false).Code, "a local request has no pair and is not touched")
	assert.Equal(t, 1, hits)

	n, err := bs.RevokeMemberGrantsOfLink(ctx, guardLink, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	live, ever, err := bs.MemberGrantsOfPerson(ctx, guardLink, guardUser, time.Now())
	require.NoError(t, err)
	assert.Empty(t, live)
	assert.True(t, ever)
}

// At the ceilings, under load: the answer is never above the lower of the grant and the cap, and once a revoke has returned no later request is allowed.
func TestConcurrentRequestsNeverPassTheLowerOfTheGrantAndTheCap(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	v := cloud.Via{LinkID: guardLink, HubUser: guardUser}
	cp := &guardCap{}
	hammer := func(need tunnel.Tier, n int, stop *atomic.Bool) (allowed *atomic.Int64) {
		allowed = &atomic.Int64{}
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for !stop.Load() {
					if ok, _ := memberGrantAllows(ctx, bs, cp.get, v, need, time.Now()); ok {
						allowed.Add(1)
					}
				}
			}()
		}
		go func() { wg.Wait() }()
		return allowed
	}
	run := func(need tunnel.Tier) *atomic.Int64 {
		var stop atomic.Bool
		a := hammer(need, 16, &stop)
		time.Sleep(150 * time.Millisecond)
		stop.Store(true)
		time.Sleep(50 * time.Millisecond)
		return a
	}

	_, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView))
	require.NoError(t, err)
	cp.set(tunnel.TierLaunch) // a view grant under the highest cap
	assert.Zero(t, run(tunnel.TierInteract).Load(), "view grant, cap launch: never interact")

	full, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelFull))
	require.NoError(t, err)
	cp.set(tunnel.TierView) // a full grant under the lowest cap
	assert.Zero(t, run(tunnel.TierInteract).Load(), "full grant, cap view: never interact")

	cp.set(tunnel.TierInteract)
	assert.Zero(t, run(tunnel.TierLaunch).Load(), "full grant, cap interact: never launch")
	assert.Positive(t, run(tunnel.TierInteract).Load(), "and interact is allowed")

	// A revoke while requests are in flight: from the moment it returns, nothing is allowed.
	var stop atomic.Bool
	var revoked atomic.Bool
	var late atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for !stop.Load() {
				after := revoked.Load() // read before the check: a request that began after the revoke returned
				if ok, _ := memberGrantAllows(ctx, bs, cp.get, v, tunnel.TierInteract, time.Now()); ok && after {
					late.Add(1)
				}
			}
		}()
	}
	time.Sleep(80 * time.Millisecond)
	_, err = bs.RevokeMemberGrant(ctx, full.GrantID, time.Now())
	require.NoError(t, err)
	revoked.Store(true)
	time.Sleep(120 * time.Millisecond)
	stop.Store(true)
	wg.Wait()
	assert.Zero(t, late.Load(), "a request that began after the revoke returned was allowed")
}

// Removing a link at this computer ends every grant that came through it, at once.
func TestRemovingALinkEndsTheGrantsThatCameThroughIt(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	r, _, l := linkedRemote(t, &fakeRevoker{})
	bs := r.srv.boardStore
	_, err := bs.Subscribe(ctx, "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	g := guardGrant(guardUser, board.MemberLevelView)
	g.LinkID = l.LinkID
	_, err = bs.CreateMemberGrant(ctx, g)
	require.NoError(t, err)
	live, _, err := bs.MemberGrantsOfPerson(ctx, l.LinkID, guardUser, time.Now())
	require.NoError(t, err)
	require.Len(t, live, 1)

	rec := call(r.srv.Router(), "DELETE", "/api/cloud/links/"+l.LinkID, "", map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	live, ever, err := bs.MemberGrantsOfPerson(ctx, l.LinkID, guardUser, time.Now())
	require.NoError(t, err)
	assert.Empty(t, live, "the grant did not outlive its link")
	assert.True(t, ever)
}
