package devicekey_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

func TestEveryRelayedKindHasItsOwnRoutesAndNoOther(t *testing.T) {
	for _, k := range devicekey.RelayedKinds {
		if k == devicekey.InputGrant {
			assert.Empty(t, devicekey.KindRoutes[k], "no route exists for it yet, so nothing is accepted")
			continue
		}
		if k == devicekey.HubWrite {
			assert.Empty(t, devicekey.KindRoutes[k], "hub-write has no list: it is every write no other kind and no exemption owns (IsHubWrite)")
			continue
		}
		assert.NotEmpty(t, devicekey.KindRoutes[k], k)
	}
	// a signed board-post cannot carry another kind's route, nor another method
	_, ok := devicekey.MatchRoute(devicekey.BoardPost, "POST", "/api/sessions/live/a/send")
	assert.False(t, ok)
	_, ok = devicekey.MatchRoute(devicekey.BoardPost, "PUT", "/api/board/t1/messages")
	assert.False(t, ok)
	_, ok = devicekey.MatchRoute(devicekey.SendToAgent, "POST", "/api/board/t1/messages")
	assert.False(t, ok)
	_, ok = devicekey.MatchRoute(devicekey.HubAutoAccept, "POST", "/api/auto-accept/disable-all")
	assert.False(t, ok)
	// a route with extra or missing segments is no match
	for _, p := range []string{"/api/board/t1/messages/x", "/api/board//messages", "/api/board/messages"} {
		_, ok = devicekey.MatchRoute(devicekey.BoardPost, "POST", p)
		assert.False(t, ok, p)
	}
}

func TestMatchRouteReturnsWhatThePathNamesAndIgnoresTheQuery(t *testing.T) {
	p, ok := devicekey.MatchRoute(devicekey.KeepFullAccess, "POST", "/api/sessions/live/Backend%20Dev/keep-full-access?x=1&y=%2F")
	require.True(t, ok)
	assert.Equal(t, map[string]string{"name": "Backend%20Dev"}, p, "exactly as signed, not decoded")
	p, ok = devicekey.MatchRoute(devicekey.GrantMember, "DELETE", "/api/member-grants/g1")
	require.True(t, ok)
	assert.Equal(t, "g1", p["id"])
}

func TestRelayedAuthorizerBindsActorOwnerPinAndRoute(t *testing.T) {
	owner := store.DeviceKey{Link: store.PairOwner, HubUser: store.PairOwner}
	bound := store.DeviceKey{Link: "lnk_1", HubUser: "hub-user-0a1b2c3d"}
	f := fixture(t)
	m := f.relayed(devicekey.BoardPost, "b")
	m.Method, m.Path = "POST", "/api/board/team1/messages"
	pin := func(link string) (string, bool) {
		if link == "lnk_1" {
			return "hub-user-0a1b2c3d", true
		}
		return "", false
	}
	auth := devicekey.RelayedAuthorizer("hub-user-0a1b2c3d", pin)
	assert.NoError(t, auth(m, bound))
	assert.NoError(t, auth(m, owner), "the owner's key, as the owner its link confirmed")

	assert.ErrorIs(t, devicekey.RelayedAuthorizer("hub-user-ffffffff", pin)(m, bound), devicekey.ErrOutsidePair, "the stamp names another person")
	assert.ErrorIs(t, devicekey.RelayedAuthorizer("", pin)(m, bound), devicekey.ErrOutsidePair, "no actor")
	other := m
	other.Link = "lnk_2"
	assert.ErrorIs(t, auth(other, owner), devicekey.ErrOutsidePair, "a link with no confirmed owner")
	assert.ErrorIs(t, devicekey.RelayedAuthorizer("hub-user-0a1b2c3d", nil)(m, owner), devicekey.ErrOutsidePair, "no pin function")
	wrongLabel := m
	wrongLabel.HubUser = "hub-user-99999999"
	assert.ErrorIs(t, devicekey.RelayedAuthorizer("hub-user-99999999", pin)(wrongLabel, owner), devicekey.ErrOutsidePair, "the owner's key cannot sign as another label")
	wrongRoute := m
	wrongRoute.Path = "/api/sessions/live/a/send"
	assert.ErrorIs(t, auth(wrongRoute, bound), devicekey.ErrWrongRequest)
}

// #21883: hub-write is every write no named kind owns and no exemption holds; a named kind's route and an exempt route can never be signed as it, so it is no way round the stricter rules of a named kind.
func TestHubWriteIsEveryOtherWriteAndNeverANamedKindsRoute(t *testing.T) {
	for _, k := range devicekey.RelayedKinds {
		for _, r := range devicekey.KindRoutes[k] {
			target := strings.NewReplacer("{project}", "t1", "{id}", "i1", "{name}", "a1").Replace(r.Pattern)
			assert.False(t, devicekey.IsHubWrite(r.Method, target), "%s %s is %s's", r.Method, r.Pattern, k)
			_, ok := devicekey.MatchRoute(devicekey.HubWrite, r.Method, target)
			assert.False(t, ok, "hub-write must refuse %s %s", r.Method, r.Pattern)
		}
	}
	for _, r := range []string{"/api/device-keys/message", "/api/device-keys/certificate", "/api/cloud/guide-revoked", "/api/board/t1/external-messages", "/api/board/t1/external-artifacts", "/api/board/t1/hub-notice"} {
		assert.True(t, devicekey.HubWriteExempt("POST", r), r)
		assert.False(t, devicekey.IsHubWrite("POST", r), r)
	}
	assert.False(t, devicekey.HubWriteExempt("PUT", "/api/cloud/guide-revoked"), "the exemption is for its own method")
	assert.True(t, devicekey.IsHubWrite("PUT", "/api/sessions/live/a/display-name"))
	assert.True(t, devicekey.IsHubWrite("DELETE", "/api/workflows/w1"))
	assert.True(t, devicekey.IsHubWrite("POST", "/api/upload?x=1"), "the query does not change what it is")
	for _, m := range []string{"GET", "HEAD", "OPTIONS"} {
		assert.False(t, devicekey.IsHubWrite(m, "/api/sessions/live/a/display-name"), m)
	}
}

// The signer's mode must reach the route's tier: a view key cannot sign a write above view, an interact key can sign interact and not launch.
func TestHubWriteNeedsASignerWhoseModeReachesTheRoute(t *testing.T) {
	f := fixture(t)
	auth := devicekey.RelayedAuthorizer("hub-user-0a1b2c3d", nil)
	bound := func(mode string) store.DeviceKey {
		return store.DeviceKey{Mode: mode, Link: "lnk_1", HubUser: "hub-user-0a1b2c3d"}
	}
	for _, tc := range []struct {
		method, target, mode string
		want                 error
	}{
		{"PUT", "/api/sessions/live/a1/display-name", "view", devicekey.ErrAboveSigner},
		{"PUT", "/api/sessions/live/a1/display-name", "interact", nil},
		{"POST", "/api/upload", "interact", devicekey.ErrAboveSigner},
		{"POST", "/api/upload", "launch", nil},
		{"PUT", "/api/sessions/live/a1/display-name", "bogus", devicekey.ErrAboveSigner},
		{"POST", "/api/not/a/route", "launch", devicekey.ErrAboveSigner},
	} {
		m := f.relayed(devicekey.HubWrite, "b")
		m.Method, m.Path, m.Link = tc.method, tc.target, "lnk_1"
		m.HubUser = "hub-user-0a1b2c3d"
		err := auth(m, bound(tc.mode))
		if tc.want == nil {
			assert.NoError(t, err, tc.method+" "+tc.target+" "+tc.mode)
		} else {
			assert.ErrorIs(t, err, tc.want, tc.method+" "+tc.target+" "+tc.mode)
		}
	}
}
