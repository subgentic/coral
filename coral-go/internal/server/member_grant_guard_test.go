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
		return memberGrantAllows(ctx, bs, cp.get, v, need, now, nil)
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

	other, _ := memberGrantAllows(ctx, bs, cp.get, cloud.Via{LinkID: guardLink, HubUser: "hub-user-cccc3333"}, tunnel.TierLaunch, now, nil)
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
					if ok, _ := memberGrantAllows(ctx, bs, cp.get, v, need, time.Now(), nil); ok {
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
				if ok, _ := memberGrantAllows(ctx, bs, cp.get, v, tunnel.TierInteract, time.Now(), nil); ok && after {
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

// #20581 (a): a person with only a View grant reaches the closed View list, and only for the board they were given; a Full grant is the whole computer; an agent scope gives nothing.
func TestAViewGranteeReachesOnlyTheBoardMessagesOfTheirOwnBoard(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	_, err := bs.Subscribe(ctx, "team2", "Dev", "Other Dev", "s", nil, "")
	require.NoError(t, err)
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	_, err = bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView)) // board team1
	require.NoError(t, err)
	hits := 0
	h := MemberGrantGuard(bs, cp.get)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	call := func(user, method, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req = req.WithContext(cloud.WithVia(req.Context(), cloud.Via{LinkID: guardLink, HubUser: user}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	assert.Equal(t, 200, call(guardUser, "GET", "/api/board/team1/messages").Code, "its own board's messages")
	for _, p := range []string{
		"/api/board/team2/messages",     // another board
		"/api/board/team1/messages/all", // a View route that is not on the list
		"/api/board/team1/subscribers",  // likewise
		"/api/board/team1/tasks",        // likewise
		"/api/sessions/live",            // the agent list: not on the list yet
		"/api/board/projects",           // every board's name
	} {
		rec := call(guardUser, "GET", p)
		assert.Equal(t, 403, rec.Code, p)
		assert.Contains(t, rec.Body.String(), memberGrantScopeCode, p)
	}
	assert.Equal(t, 1, hits, "only the one listed request reached a route")

	// A Full grant for another person is the whole computer, at the link's cap.
	_, err = bs.CreateMemberGrant(ctx, guardGrant("hub-user-cccc3333", board.MemberLevelFull))
	require.NoError(t, err)
	assert.Equal(t, 200, call("hub-user-cccc3333", "GET", "/api/sessions/live").Code)
	assert.Equal(t, 200, call("hub-user-cccc3333", "GET", "/api/board/team2/messages").Code)
}

// An agent-scope grant, or a board grant with no board, gives no View route at all (V5, B5).
func TestAnAgentScopeOrAnEmptyScopeGivesNoViewRoute(t *testing.T) {
	route := &grantRoute{method: "GET", path: "/api/board/team1/messages"}
	assert.True(t, viewScopeAllows([]board.MemberGrant{{Level: board.MemberLevelView, ScopeKind: board.MemberScopeBoard, ScopeID: "team1"}}, route))
	assert.False(t, viewScopeAllows([]board.MemberGrant{{Level: board.MemberLevelView, ScopeKind: board.MemberScopeAgent, ScopeID: "team1"}}, route), "agent scope is off")
	assert.False(t, viewScopeAllows([]board.MemberGrant{{Level: board.MemberLevelView, ScopeKind: board.MemberScopeBoard, ScopeID: ""}}, route), "an empty scope is nothing, not all")
	assert.False(t, viewScopeAllows(nil, route))
}

// #20581 (b): a stream already open when its person's grant is revoked, expires, or when the link's cap falls under it, is ended by the next sweep; one that still passes is left alone; a person who never had a grant is not touched.
func TestASweepEndsOpenStreamsWhoseGrantEndedExpiredOrWasLowered(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	var ended atomic.Int32
	open := func(user string, need tunnel.Tier) func() {
		return tunnel.RegisterOpenStream(guardLink, user, need, "GET", "/api/sessions/live/a/terminal", func() { ended.Add(1) })
	}

	full, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelFull))
	require.NoError(t, err)
	defer open(guardUser, tunnel.TierLaunch)() // a terminal
	defer open("hub-user-eeee5555", tunnel.TierLaunch)()
	now := time.Now()

	assert.Zero(t, SweepOpenStreams(ctx, bs, cp.get, now), "a live full grant keeps its terminal; a person with no grants is not decided here")
	assert.Zero(t, ended.Load())

	cp.set(tunnel.TierInteract)
	assert.Equal(t, 1, SweepOpenStreams(ctx, bs, cp.get, now), "the link's cap fell under the terminal's tier")
	ended.Store(0)
	cp.set(tunnel.TierLaunch)

	exp, err := time.Parse(time.RFC3339, full.ExpiresAt)
	require.NoError(t, err)
	assert.Equal(t, 1, SweepOpenStreams(ctx, bs, cp.get, exp.Add(time.Second)), "the grant expired while the stream was open")
	ended.Store(0)

	_, err = bs.RevokeMemberGrant(ctx, full.GrantID, now)
	require.NoError(t, err)
	assert.Equal(t, 1, SweepOpenStreams(ctx, bs, cp.get, now), "revoked while open")
	assert.EqualValues(t, 1, ended.Load(), "only the granted person's stream; the person with no grants kept theirs")
}

// The sweeper runs on a timer and stops with its context.
func TestTheSweeperEndsAStreamWithinItsInterval(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	bs := guardStore(t)
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	g, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelFull))
	require.NoError(t, err)
	ended := make(chan struct{}, 1)
	defer tunnel.RegisterOpenStream(guardLink, guardUser, tunnel.TierLaunch, "GET", "/api/sessions/live/a/terminal", func() { ended <- struct{}{} })()
	done := make(chan struct{})
	go func() { RunMemberGrantSweeper(ctx, bs, cp.get, 20*time.Millisecond); close(done) }()
	select {
	case <-ended:
		t.Fatal("ended while the grant was live")
	case <-time.After(100 * time.Millisecond):
	}
	_, err = bs.RevokeMemberGrant(ctx, g.GrantID, time.Now())
	require.NoError(t, err)
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream was not ended after the revoke")
	}
	cancel()
	<-done
}

// #20581 (f): what the grant check costs one tunneled request (the grant table read and the link read), measured and logged, never limited. A person with no grant row pays the table read only.
func TestTheGrantCheckCostPerRequestIsMeasured(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	_, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView))
	require.NoError(t, err)
	route := &grantRoute{method: "GET", path: "/api/board/team1/messages"}
	const n = 2000
	for _, c := range []struct{ name, user string }{{"granted (table read; the link read is a stub here)", guardUser}, {"no grant rows (table read)", "hub-user-zzzz9999"}} {
		v := cloud.Via{LinkID: guardLink, HubUser: c.user}
		start := time.Now()
		for i := 0; i < n; i++ {
			memberGrantAllows(ctx, bs, cp.get, v, tunnel.TierView, time.Now(), route)
		}
		t.Logf("%s: %v per request over %d", c.name, time.Since(start)/n, n)
	}
}

// #20590 (1): the route's board is in the open-stream key, so revoking the grant for board A ends A's streams while a live grant for board B keeps B's.
func TestRevokingOneBoardsGrantEndsThatBoardsStreamsAndLeavesTheOthers(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	_, err := bs.Subscribe(ctx, "team2", "Dev", "Other Dev", "s", nil, "")
	require.NoError(t, err)
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	gA, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView)) // team1
	require.NoError(t, err)
	gB := guardGrant(guardUser, board.MemberLevelView)
	gB.ScopeID, gB.BoardID = "team2", "team2"
	_, err = bs.CreateMemberGrant(ctx, gB)
	require.NoError(t, err)
	var endedA, endedB atomic.Int32
	defer tunnel.RegisterOpenStream(guardLink, guardUser, tunnel.TierView, "GET", "/api/board/team1/messages", func() { endedA.Add(1) })()
	defer tunnel.RegisterOpenStream(guardLink, guardUser, tunnel.TierView, "GET", "/api/board/team2/messages", func() { endedB.Add(1) })()

	assert.Zero(t, SweepOpenStreams(ctx, bs, cp.get, time.Now()), "both grants live")
	_, err = bs.RevokeMemberGrant(ctx, gA.GrantID, time.Now())
	require.NoError(t, err)
	assert.Equal(t, 1, SweepOpenStreams(ctx, bs, cp.get, time.Now()))
	assert.EqualValues(t, 1, endedA.Load(), "board A's stream ended with its grant")
	assert.Zero(t, endedB.Load(), "board B's grant is live, so its stream stays")
}

// #20590 (2): the guard marks a View-only person's request so the route answers with the typed shape, and does not mark a Full person's.
func TestTheGuardMarksAViewOnlyPersonsRequestAndNotAFullPersons(t *testing.T) {
	board.AllowMemberGatesForTest(t)
	ctx := context.Background()
	bs := guardStore(t)
	cp := &guardCap{}
	cp.set(tunnel.TierLaunch)
	_, err := bs.CreateMemberGrant(ctx, guardGrant(guardUser, board.MemberLevelView))
	require.NoError(t, err)
	_, err = bs.CreateMemberGrant(ctx, guardGrant("hub-user-cccc3333", board.MemberLevelFull))
	require.NoError(t, err)
	var marked bool
	h := MemberGrantGuard(bs, cp.get)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { marked = cloud.ViewOnlyFrom(r.Context()) }))
	for user, want := range map[string]bool{guardUser: true, "hub-user-cccc3333": false} {
		marked = false
		req := httptest.NewRequest("GET", "/api/board/team1/messages", nil)
		req = req.WithContext(cloud.WithVia(req.Context(), cloud.Via{LinkID: guardLink, HubUser: user}))
		h.ServeHTTP(httptest.NewRecorder(), req)
		assert.Equal(t, want, marked, user)
	}
}
