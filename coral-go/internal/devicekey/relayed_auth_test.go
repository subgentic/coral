package devicekey_test

import (
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
