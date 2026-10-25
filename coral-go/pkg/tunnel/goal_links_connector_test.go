package tunnel

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/secrets"
)

// #7411 (Security's MUST 1 on #7364): the connector itself refuses a USER stream on the Hub's service route at every tier, before the computer's API is asked, as a "never" row would; the Hub's
// own service stream passes it, and only it; and a service stream is refused on any other route. The machine's own 403 stays as the second layer (board_goal_links_test.go).
func TestTheConnectorRefusesAUserOnTheServiceRouteAtEveryTier(t *testing.T) {
	var mu sync.Mutex
	reached := map[string]int{}
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		reached[r.URL.Path]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted_requests":[]}`))
	})
	hub := newHub(t, fastCfg())
	sess, _ := connect(t, hub, local, func(l *LocalHandler) {
		l.Redactor = secrets.Redactor()
		l.MaxMode = func() Mode { return TierLaunch }
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(func() Mode { return TierLaunch })
	})
	get := func(ctx context.Context, path string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://x"+path, nil)
		return sess.RoundTrip(req)
	}
	const path = "/api/goal-links?request_id=0123456789abcdef0123456789abcdef"

	for _, tier := range []string{"view", "interact", "launch"} {
		_, err := get(WithHubTier(context.Background(), tier), path)
		require.Error(t, err, "a %s user is refused", tier)
		assert.Contains(t, err.Error(), "path_not_allowed", tier)
	}
	_, err := get(context.Background(), path) // a stream with no tier at all (the owner's own, the default)
	require.Error(t, err, "so is a stream that names no viewer")
	assert.Contains(t, err.Error(), "path_not_allowed")
	mu.Lock()
	assert.Zero(t, reached["/api/goal-links"], "the computer was never asked on behalf of a user")
	mu.Unlock()

	// The Hub's own service stream, with who asked, gets the computer's answer.
	svc := WithHubService(context.Background(), HubAsker{Server: "srv-a", Board: "team-a"})
	resp, err := get(svc, path)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	mu.Lock()
	assert.Equal(t, 1, reached["/api/goal-links"])
	mu.Unlock()
	// a query the route does not read is refused even for the service stream
	_, err = get(svc, path+"&x=1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "path_not_allowed")
	// and the service stream takes no other route
	for _, other := range []string{"/api/health", "/api/board/team/goals", "/api/sessions/live"} {
		_, err = get(svc, other)
		require.Error(t, err, other)
		assert.Contains(t, err.Error(), "path_not_allowed", other)
	}
	// a half stamp is no stamp
	_, err = get(WithHubService(context.Background(), HubAsker{Server: "srv-a"}), path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "path_not_allowed")
	// the same holds when the computer's mode is View: the service read is a View route
	hub2 := newHub(t, fastCfg())
	sess2, _ := connect(t, hub2, local, func(l *LocalHandler) {
		l.MaxMode = func() Mode { return TierView }
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(func() Mode { return TierView })
	})
	req, _ := http.NewRequestWithContext(svc, http.MethodGet, "http://x"+path, nil)
	resp, err = sess2.RoundTrip(req)
	require.NoError(t, err, "the service read is a View route, so the computer's lowest mode still answers it")
	resp.Body.Close()
	_ = strings.TrimSpace
}

// #7411 (coral-hub's point 3): the service stamp is person-less. A stream that carries it with any part of a person's identity (hub_user, hub_role, hub_org, hub_team_role, hub_user_id) is not a
// well formed stream at all, so the connector never serves it; a service stream with no identity is.
func TestAServiceStreamCarriesNoPersonsIdentity(t *testing.T) {
	base := Header{Kind: KindHTTP, Method: "GET", Path: "/api/goal-links", Query: "request_id=" + strings.Repeat("a", 32), HubService: true, AskBoard: "alpha"}
	require.NoError(t, base.validate(Limits{}.withDefaults()))
	for name, mut := range map[string]func(*Header){
		"hub_user":      func(h *Header) { h.HubUser = "hub-user-0123abcd" },
		"hub_role":      func(h *Header) { h.HubRole = HubRoleOwner },
		"hub_org":       func(h *Header) { h.HubOrg = "0123456789abcdef0123456789abcdef"[:8] + "-0000-4000-8000-000000000000" },
		"hub_user_id":   func(h *Header) { h.HubUserID = "hub-uid-" + strings.Repeat("a", 32) },
		"hub_team_role": func(h *Header) { h.HubOrg = "01234567-0000-4000-8000-000000000000"; h.HubTeamRole = "member" },
	} {
		h := base
		mut(&h)
		assert.ErrorIs(t, h.validate(Limits{}.withDefaults()), ErrBadHeader, name)
	}
}
