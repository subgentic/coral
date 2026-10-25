package tunnel

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7364: the Hub's service-only per-machine read (GET /api/goal-links, #7331 section 6). It is not an owner route and not a viewer's: Coral Hub's own service says who asked (the sender server and board of
// the request) as fields of the stream, the connector turns them into three headers on this one route and nowhere else, and the machine honours them only on a request this connector stamped.

func TestTheServiceRouteIsExactlyTheGoalLinksRead(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		want         bool
	}{
		{http.MethodGet, "/api/goal-links", true},
		{http.MethodHead, "/api/goal-links", true},
		{http.MethodPost, "/api/goal-links", false},
		{http.MethodPut, "/api/goal-links", false},
		{http.MethodDelete, "/api/goal-links", false},
		{http.MethodGet, "/api/goal-links/", false},
		{http.MethodGet, "/api/goal-links/x", false},
		{http.MethodGet, "/api/goals", false},
		{http.MethodGet, "/api/goal-link", false},
		{http.MethodGet, "/api/board/t/goals", false},
	} {
		assert.Equal(t, tc.want, IsServiceRoute(tc.method, tc.path), "%s %s", tc.method, tc.path)
	}
	assert.False(t, IsOwnerRoute(http.MethodGet, "/api/goal-links"), "a service route is not an owner route: it never gets the owner marker")
	tier := Classify(http.MethodGet, "/api/goal-links", "")
	assert.NotEqual(t, TierNever, tier, "the connector forwards it; the machine decides who may read")
}

func TestStampServiceOnlyForAServiceStreamOnTheServiceRoute(t *testing.T) {
	good := Header{Kind: KindHTTP, Method: http.MethodGet, Path: "/api/goal-links", HubService: true, AskServer: "srv-a", AskBoard: "team-a"}
	for _, tc := range []struct {
		name         string
		mutate       func(*Header)
		method, path string
		inHeaders    http.Header
		want         bool
	}{
		{"a service stream on the route", func(*Header) {}, http.MethodGet, "/api/goal-links", nil, true},
		{"the same computer's own board (no server)", func(h *Header) { h.AskServer = "" }, http.MethodGet, "/api/goal-links", nil, true},
		{"another route", func(*Header) {}, http.MethodGet, "/api/board/t/goals", nil, false},
		{"another method", func(*Header) {}, http.MethodPost, "/api/goal-links", nil, false},
		{"no service flag", func(h *Header) { h.HubService = false }, http.MethodGet, "/api/goal-links", nil, false},
		{"no board", func(h *Header) { h.AskBoard = "" }, http.MethodGet, "/api/goal-links", nil, false},
		{"an owner stream is not a service", func(h *Header) { h.HubService = false; h.HubRole = HubRoleOwner }, http.MethodGet, "/api/goal-links", nil, false},
		{"headers the request carried itself, no service flag", func(h *Header) { h.HubService = false }, http.MethodGet, "/api/goal-links", http.Header{HubServiceHeader: {"1"}, HubAskBoardHeader: {"team-a"}, HubAskServerHeader: {"x"}}, false},
		{"headers the request carried itself, other route", func(*Header) {}, http.MethodGet, "/api/health", http.Header{HubServiceHeader: {"1"}, HubAskBoardHeader: {"team-a"}}, false},
		{"lower-case and upper-case spellings", func(h *Header) { h.HubService = false }, http.MethodGet, "/api/goal-links", http.Header{"x-coral-hub-service": {"1"}, "X-CORAL-HUB-ASK-BOARD": {"b"}}, false},
	} {
		h := good
		tc.mutate(&h)
		out := scrub(tc.inHeaders, tc.method, tc.path)
		stampService(out, h, tc.method, tc.path)
		assert.Equal(t, tc.want, out.Get(HubServiceHeader) == "1", tc.name)
		if tc.want {
			assert.Equal(t, h.AskBoard, out.Get(HubAskBoardHeader), tc.name)
			assert.Equal(t, h.AskServer, out.Get(HubAskServerHeader), tc.name)
		} else {
			for _, k := range []string{HubServiceHeader, HubAskBoardHeader, HubAskServerHeader} {
				assert.Empty(t, out.Values(k), "%s: %s", tc.name, k)
			}
		}
		for k := range out {
			if http.CanonicalHeaderKey(k) != k {
				t.Errorf("%s: non-canonical key %q", tc.name, k)
			}
		}
	}
}

func TestWithHubServiceKeepsOnlyAWellFormedAsker(t *testing.T) {
	a, ok := hubServiceFrom(WithHubService(context.Background(), HubAsker{Server: "srv-a", Board: "team-a"}))
	assert.True(t, ok)
	assert.Equal(t, HubAsker{Server: "srv-a", Board: "team-a"}, a)
	_, ok = hubServiceFrom(context.Background())
	assert.False(t, ok, "no service stamp unless the hub's context made one")
	for _, bad := range []HubAsker{
		{Server: "s", Board: ""},
		{Server: "s", Board: "a\nb"},
		{Server: "s\x00", Board: "b"},
		{Server: strings.Repeat("s", 129), Board: "b"},
		{Server: "s", Board: strings.Repeat("b", 129)},
		{Server: "s", Board: "b\u202e"},
	} {
		_, ok = hubServiceFrom(WithHubService(context.Background(), bad))
		assert.False(t, ok, "%q", bad)
	}
}

func TestAServiceStampOnTheStreamIsValidatedAndNeverHalf(t *testing.T) {
	l := Limits{}.withDefaults()
	ok := Header{Kind: KindHTTP, Method: "GET", Path: "/api/goal-links", HubService: true, AskServer: "srv", AskBoard: "team"}
	assert.NoError(t, ok.validate(l))
	for name, mut := range map[string]func(*Header){
		"asker fields without the flag":  func(h *Header) { h.HubService = false },
		"the flag without a board":       func(h *Header) { h.AskBoard = "" },
		"a control character in a board": func(h *Header) { h.AskBoard = "a\x01b" },
		"an overlong server":             func(h *Header) { h.AskServer = strings.Repeat("s", 129) },
	} {
		bad := ok
		mut(&bad)
		assert.ErrorIs(t, bad.validate(l), ErrBadHeader, name)
	}
	plain := Header{Kind: KindHTTP, Method: "GET", Path: "/x"}
	assert.NoError(t, plain.validate(l), "a stream with no service stamp is as before")
}
