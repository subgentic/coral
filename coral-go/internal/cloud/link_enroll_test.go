package cloud

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// A manager enrolled with the first Hub, and a second Hub that has not been asked yet. The gate is opened for the test only.
func linkEnrollEnv(t *testing.T) (e *env, m *Manager, hub2 *fakeHub) {
	t.Helper()
	e = newEnv(t)
	m = e.manager(e.hub.srv.URL)
	start(t, m)
	require.NoError(t, m.Connect(context.Background()))
	waitState(t, m, StateConnected)
	hub2 = newFakeHub(t)
	store.AllowSecondLinkForTest(t)
	return
}

func waitEnroll(t *testing.T, m *Manager, origin, want string) LinkEnrollment {
	t.Helper()
	var got LinkEnrollment
	require.Eventually(t, func() bool {
		for _, p := range m.LinkEnrollments() {
			if p.Origin == origin {
				got = p
				return p.State == want
			}
		}
		return false
	}, 10*time.Second, 10*time.Millisecond, "enrollment of %s: want %s, last %+v", origin, want, got)
	return got
}

// #20385: a Hub is added by its address and a cap chosen out loud. The Hub is asked for a code, the code is shown, and nothing is stored until the person approves; then the link exists with its own token and cap and its own tunnel.
func TestAddingAHubByItsAddressLinksOnApproval(t *testing.T) {
	e, m, hub2 := linkEnrollEnv(t)
	hub2.approveAt.Store(1000) // not approved yet
	pe, err := m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "interact")
	require.NoError(t, err)
	assert.Equal(t, "ABCD-EFGH", pe.UserCode)
	assert.Equal(t, hub2.srv.URL+"/enroll?code=ABCD-EFGH", pe.VerificationURL)
	assert.Equal(t, "pending", pe.State)
	assert.EqualValues(t, 1, hub2.starts.Load())
	// Before approval: no row and no token for it.
	links, err := e.cs.ListLinks(context.Background())
	require.NoError(t, err)
	assert.Len(t, links, 1, "a pending enrollment is not a link")
	assert.Zero(t, hub2.tunnels.Load())

	hub2.approveAt.Store(1)
	waitEnroll(t, m, pe.Origin, "linked")
	b, err := e.cs.LinkByOrigin(context.Background(), hub2.srv.URL)
	require.NoError(t, err)
	assert.Equal(t, store.LinkSourceAdded, b.Source)
	assert.Equal(t, "interact", b.MaxMode)
	waitLink(t, m, b.LinkID, StateConnected)
	assert.NotZero(t, hub2.tunnels.Load(), "the new link dials its own Hub")
	assert.NotContains(t, e.logs.String(), fakeToken, "the token is in no log")
}

// A Hub that is not approved, denied, or that lets the code expire leaves no link and no token behind.
func TestAnEnrollmentThatIsDeniedOrExpiresLeavesNothing(t *testing.T) {
	for name, set := range map[string]func(h *fakeHub){
		"denied":  func(h *fakeHub) { h.deny.Store(true) },
		"expired": func(h *fakeHub) { h.expireAfter.Store(1) },
	} {
		t.Run(name, func(t *testing.T) {
			e, m, hub2 := linkEnrollEnv(t)
			set(hub2)
			pe, err := m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "view")
			require.NoError(t, err)
			got := waitEnroll(t, m, pe.Origin, name)
			assert.NotEmpty(t, got.Message)
			links, _ := e.cs.ListLinks(context.Background())
			assert.Len(t, links, 1)
		})
	}
}

// The code has a life of its own: past the device code's expiry the enrollment ends even if the Hub is never asked again.
func TestAPendingEnrollmentExpiresOnItsOwn(t *testing.T) {
	e := newEnv(t)
	var skew atomic.Int64
	m := e.manager(e.hub.srv.URL)
	m.o.Now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	start(t, m)
	require.NoError(t, m.Connect(context.Background()))
	waitState(t, m, StateConnected)
	hub2 := newFakeHub(t)
	store.AllowSecondLinkForTest(t)
	hub2.approveAt.Store(1000)
	_, err := m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "view")
	require.NoError(t, err)
	skew.Store(int64(16 * time.Minute))
	got := waitEnroll(t, m, mustOrigin(t, hub2.srv.URL), "expired")
	assert.Contains(t, got.Message, "expired")
	links, _ := e.cs.ListLinks(context.Background())
	assert.Len(t, links, 1)
}

func mustOrigin(t *testing.T, raw string) string {
	t.Helper()
	o, err := store.CanonicalHubOrigin(raw)
	require.NoError(t, err)
	return o
}

// A second Add for the same Hub ends the first pending enrollment: only the newest code can link, and the old one is never polled again.
func TestASecondAddCancelsTheFirstPendingEnrollment(t *testing.T) {
	_, m, hub2 := linkEnrollEnv(t)
	hub2.approveAt.Store(1000)
	_, err := m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "view")
	require.NoError(t, err)
	_, err = m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "launch")
	require.NoError(t, err)
	assert.EqualValues(t, 2, hub2.starts.Load())
	require.Len(t, m.LinkEnrollments(), 1, "one pending enrollment per Hub")
	assert.Equal(t, "launch", m.LinkEnrollments()[0].Cap)
}

// Cancel (the CLI's Ctrl-C, a Remove) drops the pending enrollment: an approval that comes later links nothing.
func TestCancelledEnrollmentLinksNothingEvenIfApprovedLater(t *testing.T) {
	e, m, hub2 := linkEnrollEnv(t)
	hub2.approveAt.Store(1000)
	pe, err := m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "view")
	require.NoError(t, err)
	require.True(t, m.CancelLinkEnrollment(pe.Origin))
	assert.Empty(t, m.LinkEnrollments())
	hub2.approveAt.Store(1)
	time.Sleep(200 * time.Millisecond) // several poll intervals (20 ms): a stopped poller asks nothing
	links, _ := e.cs.ListLinks(context.Background())
	assert.Len(t, links, 1, "nothing was linked")
	assert.False(t, m.CancelLinkEnrollment(pe.Origin), "nothing left to cancel")
}

// Remove of a link also drops a pending enrollment for the same Hub.
func TestRemovingALinkCancelsItsPendingEnrollment(t *testing.T) {
	_, m, hub2 := linkEnrollEnv(t)
	hub2.approveAt.Store(1000)
	pe, err := m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "view")
	require.NoError(t, err)
	m.LinkRemoved(pe.Origin)
	assert.Empty(t, m.LinkEnrollments())
}

// Refused before the Hub is asked: a Hub already linked (said plainly), the gate shut, and the 8-link cap, where a pending enrollment counts.
func TestAddByAddressRefusalsNeverAskTheHub(t *testing.T) {
	ctx := context.Background()
	t.Run("already linked", func(t *testing.T) {
		e, m, _ := linkEnrollEnv(t)
		_, err := m.AddLinkByOrigin(ctx, e.hub.srv.URL, "view")
		require.ErrorIs(t, err, store.ErrLinkExists)
		assert.Contains(t, err.Error(), "already linked to that Hub")
		assert.EqualValues(t, 1, e.hub.starts.Load(), "only the first enrollment asked")
	})
	t.Run("gate shut", func(t *testing.T) {
		e := newEnv(t)
		m := e.manager(e.hub.srv.URL)
		start(t, m)
		require.NoError(t, m.Connect(ctx))
		waitState(t, m, StateConnected)
		hub2 := newFakeHub(t)
		_, err := m.AddLinkByOrigin(ctx, hub2.srv.URL, "view")
		require.ErrorIs(t, err, store.ErrSecondLinkNotYet)
		assert.Zero(t, hub2.starts.Load())
	})
	t.Run("pending counts toward the cap", func(t *testing.T) {
		e, m, hub2 := linkEnrollEnv(t)
		hub2.approveAt.Store(1000)
		for i := 0; i < store.MaxCloudLinks-3; i++ { // 6 links
			_, err := e.cs.AddLink(ctx, fmt.Sprintf("https://hub%d.example.com", i), "srv_x", "L", fakeToken, "view")
			require.NoError(t, err)
		}
		_, err := m.AddLinkByOrigin(ctx, hub2.srv.URL, "view") // 7 with the pending one
		require.NoError(t, err)
		hub3 := newFakeHub(t)
		hub3.approveAt.Store(1000)
		_, err = m.AddLinkByOrigin(ctx, hub3.srv.URL, "view") // 8
		require.NoError(t, err)
		hub4 := newFakeHub(t)
		_, err = m.AddLinkByOrigin(ctx, hub4.srv.URL, "view")
		require.ErrorIs(t, err, store.ErrTooManyLinks)
		assert.Zero(t, hub4.starts.Load())
	})
	t.Run("bad cap or address", func(t *testing.T) {
		_, m, hub2 := linkEnrollEnv(t)
		_, err := m.AddLinkByOrigin(ctx, hub2.srv.URL, "")
		require.Error(t, err, "the cap is chosen out loud")
		_, err = m.AddLinkByOrigin(ctx, "http://hub.example.com", "view")
		require.Error(t, err, "a Hub address must be https")
		assert.Zero(t, hub2.starts.Load())
	})
}

// A verification link the Hub names on another site is not shown; the person is told, and the Hub's own enroll page is the fallback.
func TestAVerificationLinkOnAnotherSiteIsDropped(t *testing.T) {
	_, m, hub2 := linkEnrollEnv(t)
	hub2.approveAt.Store(1000)
	hub2.verifyBase.Store("https://evil.example.com")
	pe, err := m.AddLinkByOrigin(context.Background(), hub2.srv.URL, "view")
	require.NoError(t, err)
	assert.Equal(t, hub2.srv.URL+"/enroll", pe.VerificationURL)
	assert.Contains(t, pe.Note, "another site")
}

// The Hub's words are text only: control and format characters are dropped from what is shown.
func TestEnrollmentTextIsCleaned(t *testing.T) {
	assert.Equal(t, "Laptop", cleanLinkText("Lap‮top\x07", 40))
	assert.Equal(t, "abc", cleanLinkText("abcdef", 3))
}
