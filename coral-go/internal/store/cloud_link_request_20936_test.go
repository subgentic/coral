package store

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20936 (design #20901 v4): a second Hub asks to join a Coral already linked. The store holds a pending request; nothing is linked or granted by it.

func reqRig(t *testing.T) (*CloudStore, context.Context, time.Time) {
	t.Helper()
	cs, _, _ := twoLinks(t)
	_, err := cs.db.ExecContext(context.Background(), `INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, 'launch')`, linkMaxModeKey)
	require.NoError(t, err)
	return cs, context.Background(), time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
}

func TestARequestStartsPendingAndLinksNothing(t *testing.T) {
	cs, ctx, now := reqRig(t)
	before, _ := cs.ListLinks(ctx)
	id, secret, err := cs.CreateLinkRequest(ctx, "https://Hub-C.example.com:443", "interact", "cred-1", now)
	require.NoError(t, err)
	assert.NotEmpty(t, id)
	assert.Len(t, secret, 32)
	st, err := cs.LinkRequestStatus(ctx, id, secret, now)
	require.NoError(t, err)
	assert.Equal(t, "pending", st)
	after, _ := cs.ListLinks(ctx)
	assert.Len(t, after, len(before), "a request links nothing")
	// The secret is stored only as a hash.
	var raw string
	require.NoError(t, cs.db.GetContext(ctx, &raw, `SELECT group_concat(poll_hash || code_hash || poll_salt || code_salt, '|') FROM cloud_link_request`))
	assert.NotContains(t, raw, secret)
	// A wrong secret, or an unknown id, is the same answer.
	_, e1 := cs.LinkRequestStatus(ctx, id, strings.Repeat("a", 32), now)
	_, e2 := cs.LinkRequestStatus(ctx, "req-nope", secret, now)
	assert.ErrorIs(t, e1, ErrLinkRequestNone)
	assert.ErrorIs(t, e2, ErrLinkRequestNone)
}

func TestARequestIsRefusedBeforeAnyCardForABadAddressCapOrALinkedHub(t *testing.T) {
	cs, ctx, now := reqRig(t)
	for _, tc := range []struct{ hub, cap string }{
		{"http://hub-c.example.com", "view"},                            // not https
		{"https://u:p@hub-c.example.com", "view"},                       // userinfo
		{"https://hub-c.example.com/x", "view"},                         // path
		{"https://hub-c.example.com", "root"},                           // cap
		{"https://hub-c.example.com", ""},                               // no cap
		{"https://" + strings.Repeat("a", 90) + ".example.com", "view"}, // over 80: refused, not cut
	} {
		_, _, err := cs.CreateLinkRequest(ctx, tc.hub, tc.cap, "cred-1", now)
		assert.Error(t, err, tc.hub+" "+tc.cap)
	}
	_, _, err := cs.CreateLinkRequest(ctx, "https://hub-b.example.com", "view", "cred-1", now)
	assert.ErrorIs(t, err, ErrLinkExists, "a Hub already linked")
	n, _ := cs.PendingLinkRequests(ctx, now)
	assert.Empty(t, n)
}

func TestAllowShowsTheCodeOnceAndStatusNeverDoes(t *testing.T) {
	cs, ctx, now := reqRig(t)
	id, secret, _ := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "launch", "cred-1", now)
	code, given, err := cs.AllowLinkRequest(ctx, id, "interact", now)
	require.NoError(t, err)
	assert.Regexp(t, `^\d{8}$`, code)
	assert.Equal(t, "interact", given, "the Operator may allow a lower cap")
	st, _ := cs.LinkRequestStatus(ctx, id, secret, now)
	assert.Equal(t, "allowed", st)
	var raw string
	require.NoError(t, cs.db.GetContext(ctx, &raw, `SELECT group_concat(code_hash, '|') FROM cloud_link_request`))
	assert.NotContains(t, raw, code, "stored only as a salted hash")
	// A second Allow gives no second code.
	_, _, err = cs.AllowLinkRequest(ctx, id, "interact", now)
	assert.ErrorIs(t, err, ErrLinkRequestState)
	// Never higher than asked.
	id2, _, _ := cs.CreateLinkRequest(ctx, "https://hub-d.example.com", "view", "cred-1", now)
	_, _, err = cs.AllowLinkRequest(ctx, id2, "launch", now)
	assert.ErrorIs(t, err, ErrLinkRequestCap)
}

func TestTheCapGivenIsBoundedByThisComputersOwnMax(t *testing.T) {
	cs, ctx, now := reqRig(t)
	_, err := cs.db.ExecContext(ctx, `INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, 'view')`, linkMaxModeKey)
	require.NoError(t, err)
	id, _, _ := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "launch", "cred-1", now)
	_, given, err := cs.AllowLinkRequest(ctx, id, "launch", now)
	require.NoError(t, err)
	assert.Equal(t, "view", given)
}

func TestDenyEndsARequestAndTwoDenialsMuteThatHubForAnHour(t *testing.T) {
	cs, ctx, now := reqRig(t)
	for i := 0; i < 2; i++ {
		id, secret, err := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now.Add(time.Duration(i)*time.Minute))
		require.NoError(t, err)
		require.NoError(t, cs.DenyLinkRequest(ctx, id, now.Add(time.Duration(i)*time.Minute)))
		st, _ := cs.LinkRequestStatus(ctx, id, secret, now.Add(time.Duration(i)*time.Minute))
		assert.Equal(t, "denied", st)
	}
	_, _, err := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now.Add(5*time.Minute))
	assert.ErrorIs(t, err, ErrLinkRequestMuted)
	_, _, err = cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now.Add(70*time.Minute))
	assert.NoError(t, err, "an hour later it may ask again")
}

func TestARequestExpiresAndAnAllowedOneExpiresSooner(t *testing.T) {
	cs, ctx, now := reqRig(t)
	id, secret, _ := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now)
	st, _ := cs.LinkRequestStatus(ctx, id, secret, now.Add(11*time.Minute))
	assert.Equal(t, "expired", st)
	_, _, err := cs.AllowLinkRequest(ctx, id, "view", now.Add(11*time.Minute))
	assert.ErrorIs(t, err, ErrLinkRequestState, "an expired request cannot be allowed")

	id2, secret2, _ := cs.CreateLinkRequest(ctx, "https://hub-d.example.com", "view", "cred-1", now)
	code, _, err := cs.AllowLinkRequest(ctx, id2, "view", now.Add(time.Minute))
	require.NoError(t, err)
	_, _, err = cs.FinishLinkRequest(ctx, id2, secret2, code, now.Add(7*time.Minute))
	assert.ErrorIs(t, err, ErrLinkRequestNone, "five minutes after Allow it is over")
}

func TestFiveWrongCodesKillTheRequestEvenForTheRightCodeAfterwards(t *testing.T) {
	cs, ctx, now := reqRig(t)
	id, secret, _ := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now)
	code, _, _ := cs.AllowLinkRequest(ctx, id, "view", now)
	wrong := "00000000"
	if code == wrong {
		wrong = "11111111"
	}
	for i := 0; i < 5; i++ {
		_, _, err := cs.FinishLinkRequest(ctx, id, secret, wrong, now)
		assert.ErrorIs(t, err, ErrLinkRequestCode, fmt.Sprint(i))
	}
	_, _, err := cs.FinishLinkRequest(ctx, id, secret, code, now)
	assert.ErrorIs(t, err, ErrLinkRequestNone, "after five wrong codes the right one is too late")
	st, _ := cs.LinkRequestStatus(ctx, id, secret, now)
	assert.Equal(t, "denied", st)
}

func TestFinishNeedsTheSecretAndTheCodeAndTakesNoAddress(t *testing.T) {
	cs, ctx, now := reqRig(t)
	id, secret, _ := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "interact", "cred-1", now)
	_, _, err := cs.FinishLinkRequest(ctx, id, secret, "12345678", now)
	assert.ErrorIs(t, err, ErrLinkRequestState, "not allowed yet")
	code, _, _ := cs.AllowLinkRequest(ctx, id, "interact", now)
	_, _, err = cs.FinishLinkRequest(ctx, id, strings.Repeat("b", 32), code, now)
	assert.ErrorIs(t, err, ErrLinkRequestNone, "the secret is checked first and says nothing about the code")
	hub, cap, err := cs.FinishLinkRequest(ctx, id, secret, code, now)
	require.NoError(t, err)
	assert.Equal(t, "https://hub-c.example.com", hub, "only the origin that was allowed")
	assert.Equal(t, "interact", cap)
	st, _ := cs.LinkRequestStatus(ctx, id, secret, now)
	assert.Equal(t, "done", st)
}

func TestTwoFinishesAtOnceMakeOneLink(t *testing.T) {
	cs, ctx, now := reqRig(t)
	id, secret, _ := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now)
	code, _, _ := cs.AllowLinkRequest(ctx, id, "view", now)
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := cs.FinishLinkRequest(ctx, id, secret, code, now); err == nil {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, 1, won)
}

func TestLimitsOnWaitingAndOnAskingOften(t *testing.T) {
	cs, ctx, now := reqRig(t)
	// 1 waiting per Hub address.
	_, _, err := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now)
	require.NoError(t, err)
	_, _, err = cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now)
	assert.ErrorIs(t, err, ErrLinkRequestBusy)
	// 3 waiting per credential.
	for _, h := range []string{"d", "e"} {
		_, _, err = cs.CreateLinkRequest(ctx, "https://hub-"+h+".example.com", "view", "cred-1", now)
		require.NoError(t, err)
	}
	_, _, err = cs.CreateLinkRequest(ctx, "https://hub-f.example.com", "view", "cred-1", now)
	assert.ErrorIs(t, err, ErrLinkRequestBusy, "a fourth for one credential")
	_, _, err = cs.CreateLinkRequest(ctx, "https://hub-f.example.com", "view", "cred-2", now)
	assert.NoError(t, err, "another credential has its own")
	// 5 requests an hour per credential.
	cs2, ctx2, now2 := reqRig(t)
	for i := 0; i < 5; i++ {
		id, _, err := cs2.CreateLinkRequest(ctx2, fmt.Sprintf("https://h%d.example.com", i), "view", "cred-9", now2)
		require.NoError(t, err)
		require.NoError(t, cs2.CancelLinkRequest(ctx2, id))
	}
	_, _, err = cs2.CreateLinkRequest(ctx2, "https://h9.example.com", "view", "cred-9", now2)
	assert.ErrorIs(t, err, ErrLinkRequestRate)
}

func TestAFullComputerNeverShowsACard(t *testing.T) {
	cs, ctx, now := reqRig(t)
	for i := 0; i < MaxCloudLinks-2; i++ {
		_, err := cs.db.ExecContext(ctx, `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, scope, owner_account, owner_user, created_at, source)
			VALUES (?, ?, ?, 'L', 'v1:x', 'active', 'view', 'all', 'a', 'u', '2026-01-01T00:00:00Z', 'added')`, fmt.Sprintf("lnk-%08x", 100+i), fmt.Sprintf("https://full%d.example.com", i), fmt.Sprintf("srv_f%d", i))
		require.NoError(t, err)
	}
	_, _, err := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", "cred-1", now)
	assert.ErrorIs(t, err, ErrTooManyLinks)
	p, _ := cs.PendingLinkRequests(ctx, now)
	assert.Empty(t, p)
}

func TestThePendingFeedHoldsOnlyWaitingRequestsAndNoSecrets(t *testing.T) {
	cs, ctx, now := reqRig(t)
	id, secret, _ := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "interact", "cred-1", now)
	id2, _, _ := cs.CreateLinkRequest(ctx, "https://hub-d.example.com", "view", "cred-1", now)
	_, _, _ = cs.AllowLinkRequest(ctx, id2, "view", now)
	p, err := cs.PendingLinkRequests(ctx, now)
	require.NoError(t, err)
	require.Len(t, p, 1)
	assert.Equal(t, id, p[0].ID)
	assert.Equal(t, "https://hub-c.example.com", p[0].Hub)
	assert.Equal(t, "interact", p[0].CapAsked)
	assert.NotContains(t, fmt.Sprintf("%+v", p[0]), secret)
	p, _ = cs.PendingLinkRequests(ctx, now.Add(11*time.Minute))
	assert.Empty(t, p, "expired requests leave the feed")
}
