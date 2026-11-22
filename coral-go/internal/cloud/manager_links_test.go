package cloud

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// twoLinks starts a manager enrolled with the first Hub (e.hub), adds a second link to another Hub by the store, and returns both links. The gate is opened for this test only.
func twoLinks(t *testing.T, e *env, capB string) (m *Manager, hub2 *fakeHub, a, b *store.CloudLink) {
	t.Helper()
	m = e.manager(e.hub.srv.URL)
	start(t, m)
	require.NoError(t, m.Connect(context.Background()))
	waitState(t, m, StateConnected)
	hub2 = newFakeHub(t)
	store.AllowSecondLinkForTest(t)
	var err error
	b, err = e.cs.AddLink(context.Background(), hub2.srv.URL, "srv_1", "Laptop B", fakeToken, capB)
	require.NoError(t, err)
	a, err = e.cs.LinkByOrigin(context.Background(), e.hub.srv.URL)
	require.NoError(t, err)
	return
}

func waitLink(t *testing.T, m *Manager, id, want string) {
	t.Helper()
	require.Eventually(t, func() bool { return m.LinkStatus(id).State == want }, 10*time.Second, 10*time.Millisecond, "link %s: want %s, last %+v", id, want, m.LinkStatus(id))
}

// #20368: every active link has its own connector: the second Hub is dialed with its own token and each tunnel stamps its own link.
func TestEachActiveLinkDialsItsOwnHub(t *testing.T) {
	e := newEnv(t)
	m, hub2, a, b := twoLinks(t, e, "view")
	require.NotEqual(t, a.LinkID, b.LinkID)
	require.Zero(t, hub2.tunnels.Load(), "added but not yet announced to the connector")
	m.LinksChanged(context.Background())
	waitLink(t, m, b.LinkID, StateConnected)
	assert.EqualValues(t, 1, hub2.tunnels.Load())
	assert.Equal(t, StateConnected, m.Status().State, "the first Hub is still up")
	assert.EqualValues(t, 1, e.hub.tunnels.Load(), "and was not redialed")

	s1, s2 := e.hub.session(t), hub2.session(t)
	code, _ := viaTunnel(t, s1, "GET", "/api/health")
	require.Equal(t, 200, code)
	code, _ = viaTunnel(t, s2, "GET", "/api/health")
	require.Equal(t, 200, code)
	e.local.mu.Lock()
	defer e.local.mu.Unlock()
	require.Len(t, e.local.seen, 2)
	got := []string{e.local.seen[0].Get(tunnel.LinkHeader), e.local.seen[1].Get(tunnel.LinkHeader)}
	assert.Equal(t, []string{a.LinkID, b.LinkID}, got, "each request is stamped with the link its tunnel belongs to")
}

// A restart dials every active link, not only the enrollment's.
func TestARestartDialsEveryActiveLink(t *testing.T) {
	e := newEnv(t)
	m, hub2, _, b := twoLinks(t, e, "view")
	_ = m
	m2 := e.manager(e.hub.srv.URL)
	start(t, m2)
	waitLink(t, m2, b.LinkID, StateConnected)
	assert.GreaterOrEqual(t, hub2.tunnels.Load(), int64(1))
}

// Revoking one link ends its tunnel and leaves the other up; a link being removed is never dialed again.
func TestRemovingOneLinkLeavesTheOtherUp(t *testing.T) {
	e := newEnv(t)
	m, hub2, _, b := twoLinks(t, e, "view")
	m.LinksChanged(context.Background())
	waitLink(t, m, b.LinkID, StateConnected)
	s2 := hub2.session(t)
	before1 := e.hub.tunnels.Load()

	require.NoError(t, e.cs.BeginRemoveLink(context.Background(), b.LinkID))
	m.StopLink(b.LinkID)
	assert.Equal(t, StateIdle, m.LinkStatus(b.LinkID).State)
	code, _ := viaTunnel(t, s2, "GET", "/api/health")
	assert.NotEqual(t, 200, code, "the removed link's tunnel is closed")
	time.Sleep(300 * time.Millisecond)
	assert.EqualValues(t, 1, hub2.tunnels.Load(), "no redial of a link that is being removed")
	m.LinksChanged(context.Background()) // a later sweep does not bring it back
	time.Sleep(200 * time.Millisecond)
	assert.EqualValues(t, 1, hub2.tunnels.Load())
	assert.Equal(t, StateConnected, m.Status().State, "the first Hub stays connected")
	assert.Equal(t, before1, e.hub.tunnels.Load())
	s1 := e.hub.session(t)
	code, _ = viaTunnel(t, s1, "GET", "/api/health")
	assert.Equal(t, 200, code)
}

// A Hub that refuses one link's token marks that link revoked and nothing else.
func TestAHubRefusingOneLinkRevokesOnlyThatLink(t *testing.T) {
	e := newEnv(t)
	m, hub2, a, b := twoLinks(t, e, "view")
	hub2.revoked.Store(true)
	m.LinksChanged(context.Background())
	waitLink(t, m, b.LinkID, StateRevoked)
	gb, _ := e.cs.LinkByOrigin(context.Background(), hub2.srv.URL)
	assert.Equal(t, store.LinkStateRevoked, gb.State)
	ga, _ := e.cs.LinkByOrigin(context.Background(), e.hub.srv.URL)
	assert.Equal(t, store.LinkStateActive, ga.State)
	assert.Equal(t, StateConnected, m.Status().State)
	assert.Equal(t, a.LinkID, ga.LinkID)
	m.LinksChanged(context.Background())
	time.Sleep(200 * time.Millisecond)
	assert.EqualValues(t, 1, hub2.tunnels.Load(), "a revoked link is not dialed again")
}

// #20581 (e): the Hub's revoke of one link calls LinkEnded for that link and no other, so the server can end the grants that came through it.
func TestAHubRevokeCallsLinkEndedForThatLinkOnly(t *testing.T) {
	var mu sync.Mutex
	var ended []string
	old := LinkEnded
	LinkEnded = func(_ context.Context, id string) { mu.Lock(); ended = append(ended, id); mu.Unlock() }
	t.Cleanup(func() { LinkEnded = old })

	e := newEnv(t)
	m, hub2, a, b := twoLinks(t, e, "view")
	m.LinksChanged(context.Background())
	waitLink(t, m, b.LinkID, StateConnected)
	mu.Lock()
	require.Empty(t, ended, "nothing ended while both links are up")
	mu.Unlock()

	hub2.revoked.Store(true)
	m.StopLink(b.LinkID) // drop the live tunnel so the connector redials and meets the refusal
	m.LinksChanged(context.Background())
	waitLink(t, m, b.LinkID, StateRevoked)
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{b.LinkID}, ended, "the revoked link, once; never link %s", a.LinkID)
}

// Each link has its own cap: B at view cannot do what A at interact can, and lowering B's cap closes B's tunnel at once.
func TestEachLinkKeepsItsOwnCap(t *testing.T) {
	e := newEnv(t)
	e.mode.Store(int32(tunnel.TierInteract)) // the enrollment's link: the setting
	m, hub2, _, b := twoLinks(t, e, "interact")
	m.LinksChanged(context.Background())
	waitLink(t, m, b.LinkID, StateConnected)
	s1, s2 := e.hub.session(t), hub2.session(t)
	code, _ := viaTunnel(t, s1, "POST", "/api/sessions/live/a/send")
	assert.Equal(t, 200, code)
	code, _ = viaTunnel(t, s2, "POST", "/api/sessions/live/a/send")
	assert.Equal(t, 200, code)

	_, err := e.cs.SetLinkCap(context.Background(), b.LinkID, "view")
	require.NoError(t, err)
	m.LinksChanged(context.Background())
	code, _ = viaTunnel(t, s2, "POST", "/api/sessions/live/a/send")
	assert.NotEqual(t, 200, code, "B's old tunnel, which allowed interact, is closed")
	s2b := hub2.session(t) // B dials again at its new cap
	code, _ = viaTunnel(t, s2b, "POST", "/api/sessions/live/a/send")
	assert.NotEqual(t, 200, code, "at view")
	code, _ = viaTunnel(t, s2b, "GET", "/api/health")
	assert.Equal(t, 200, code)
	code, _ = viaTunnel(t, s1, "POST", "/api/sessions/live/a/send")
	assert.Equal(t, 200, code, "A kept its cap and its tunnel")
}

// Connect to a Hub an added link already has says so at once, before the Hub is asked for a code.
func TestConnectToAnAddedLinksHubIsRefusedBeforeAskingTheHub(t *testing.T) {
	e := newEnv(t)
	store.AllowSecondLinkForTest(t)
	// An enrollment elsewhere, then a second link to the test Hub; the enrollment is then forgotten so Connect has a free slot.
	require.NoError(t, e.cs.Save(context.Background(), "https://other.example.com", "srv_o", "O", "tok-o"))
	_, err := e.cs.AddLink(context.Background(), e.hub.srv.URL, "srv_1", "B", fakeToken, "view")
	require.NoError(t, err)
	require.NoError(t, e.cs.Delete(context.Background()))
	m := e.manager(e.hub.srv.URL)
	start(t, m)
	err = m.Connect(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already linked to that Hub")
	assert.Zero(t, e.hub.starts.Load(), "the Hub was not asked for a code")
	assert.Contains(t, m.Status().LastError, "already linked to that Hub")
}
