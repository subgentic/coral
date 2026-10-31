package tunnel

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	guideBoard = "dev team"
	guideLabel = "hub-user-1234abcd"
	guideSince = "2026-10-31T07:00:00Z"
)

func guideHeader() Header {
	return Header{Kind: KindHTTP, Method: http.MethodPost, Path: "/api/board/dev%20team/messages", HubRole: HubRoleGuide, GuideBoard: guideBoard, GuideLabel: guideLabel, GuideSince: guideSince}
}

func TestTheGuideTableIsClosedAndExact(t *testing.T) {
	yes := [][2]string{
		{"GET", "/api/board/b/messages"}, {"POST", "/api/board/b/messages"}, {"GET", "/api/board/b/goals"}, {"GET", "/api/board/b/goals/12"}, {"POST", "/api/board/b/goals"},
		{"GET", "/api/board/b/artifacts"}, {"GET", "/api/artifacts/" + strings.Repeat("a", 64)}, {"GET", "/api/artifacts/" + strings.Repeat("a", 64) + "/meta"},
		{"GET", "/api/artifacts/" + strings.Repeat("a", 64) + "/comments"}, {"POST", "/api/artifacts/" + strings.Repeat("a", 64) + "/comments"},
		{"GET", "/api/artifacts/" + strings.Repeat("a", 64) + "/versions"}, {"GET", "/api/artifacts/series/s1"}, {"GET", "/api/artifacts/series/s1/versions"}, {"HEAD", "/api/board/b/messages"},
	}
	for _, c := range yes {
		assert.True(t, IsGuideRoute(c[0], c[1]), "%s %s", c[0], c[1])
	}
	no := [][2]string{
		{"DELETE", "/api/board/b/messages/3"}, {"PATCH", "/api/board/b/goals/12"}, {"POST", "/api/board/b/goals/12/close"}, {"GET", "/api/board/b/settings"}, {"PUT", "/api/board/b/settings"},
		{"GET", "/api/artifacts/" + strings.Repeat("a", 64) + "/readers"}, {"POST", "/api/artifacts/" + strings.Repeat("a", 64) + "/comments/3/resolve"}, {"PUT", "/api/artifacts/" + strings.Repeat("a", 64) + "/star"},
		{"DELETE", "/api/artifacts/" + strings.Repeat("a", 64)}, {"POST", "/api/artifacts/" + strings.Repeat("a", 64) + "/comments/3/send"}, {"GET", "/api/artifacts"}, {"GET", "/api/team-artifacts"},
		{"GET", "/api/artifacts/xyz"}, {"POST", "/api/sessions/launch"}, {"GET", "/api/sessions/live"}, {"POST", "/api/agent/artifacts"}, {"GET", "/api/agent/x"}, {"GET", "/api/board/b/messages/extra"},
		{"GET", "/api/board/b/goals/1x"}, {"GET", "/api/board//messages"}, {"GET", "/api/board/../messages"},
	}
	for _, c := range no {
		assert.False(t, IsGuideRoute(c[0], c[1]), "%s %s", c[0], c[1])
	}
}

// Every guide route is also in the route table: the viewer's tier and the machine's mode apply to a guide as to anyone (the guide table only takes away).
func TestEveryGuideRouteIsInTheRouteTable(t *testing.T) {
	for _, g := range GuideRoutes() {
		found := false
		for _, r := range routeTable {
			if methodMatches(r.method, g.Method) && r.pattern == g.Pattern {
				found = true
			}
		}
		if !found && strings.Contains(g.Pattern, "{series_id}") { // the series routes are listed by their own name in the table
			for _, r := range routeTable {
				if methodMatches(r.method, g.Method) && strings.Contains(r.pattern, "series") {
					found = true
				}
			}
		}
		assert.True(t, found, "%s %s is a guide route that the route table does not list", g.Method, g.Pattern)
	}
}

func TestStampGuideOnlyForACompleteGuideStreamOnAGuideRoute(t *testing.T) {
	forged := func() http.Header {
		return http.Header{HubRoleHeader: {"owner"}, HubGuideBoardHeader: {"other"}, HubGuideLabelHeader: {"hub-user-ffffffff"}, HubGuideSinceHeader: {"2000-01-01T00:00:00Z"}, HubUserHeader: {"hub-user-ffffffff"}}
	}
	// a complete stream on a guide route: the four headers are the stream's, the client's copies are gone
	out := forged()
	stampRole(out, guideHeader(), "POST", "/api/board/dev team/messages")
	stampGuide(out, guideHeader(), "POST", "/api/board/dev team/messages")
	assert.Equal(t, "guide", out.Get(HubRoleHeader))
	assert.Equal(t, guideBoard, out.Get(HubGuideBoardHeader))
	assert.Equal(t, guideLabel, out.Get(HubGuideLabelHeader))
	assert.Equal(t, guideSince, out.Get(HubGuideSinceHeader))
	assert.Equal(t, []string{guideLabel}, out[HubUserHeader])
	// another route: none of them, and the client's copies are dropped
	out = forged()
	stampRole(out, guideHeader(), "POST", "/api/sessions/launch")
	stampGuide(out, guideHeader(), "POST", "/api/sessions/launch")
	for _, k := range []string{HubRoleHeader, HubGuideBoardHeader, HubGuideLabelHeader, HubGuideSinceHeader} {
		assert.Empty(t, out.Get(k), k)
	}
	// every part of the stamp is needed; one missing or malformed part is no stamp
	for name, mut := range map[string]func(h *Header){
		"no board": func(h *Header) { h.GuideBoard = "" }, "board with a slash": func(h *Header) { h.GuideBoard = "a/b" }, "no label": func(h *Header) { h.GuideLabel = "" },
		"bad label": func(h *Header) { h.GuideLabel = "someone" }, "no start": func(h *Header) { h.GuideSince = "" }, "start not UTC": func(h *Header) { h.GuideSince = "2026-10-31T07:00:00+02:00" },
		"start a date": func(h *Header) { h.GuideSince = "2026-10-31" }, "no role": func(h *Header) { h.HubRole = "" }, "owner role": func(h *Header) { h.HubRole = HubRoleOwner },
		"a team member too": func(h *Header) { h.HubOrg = "0b7c2e4a-5d1f-4c8e-9a36-2f4d8e1b7c90" }, "another hub user": func(h *Header) { h.HubUser = "hub-user-00000000" },
	} {
		h := guideHeader()
		mut(&h)
		out = forged()
		stampGuide(out, h, "POST", "/api/board/dev team/messages")
		assert.Empty(t, out.Get(HubGuideBoardHeader), name)
		assert.Empty(t, out.Get(HubGuideLabelHeader), name)
		assert.NotEqual(t, "guide", out.Get(HubRoleHeader), name)
	}
}

func TestAGuideStreamHeaderIsValidatedWhole(t *testing.T) {
	l := Limits{}.withDefaults()
	h := guideHeader()
	require.NoError(t, h.validate(l))
	for name, mut := range map[string]func(h *Header){
		"guide fields without the role": func(h *Header) { h.HubRole = "" }, "board only": func(h *Header) { h.GuideLabel, h.GuideSince = "", "" }, "no start": func(h *Header) { h.GuideSince = "" },
		"owner with guide fields": func(h *Header) { h.HubRole = HubRoleOwner }, "a service stream": func(h *Header) { h.HubService, h.AskServer, h.AskBoard = true, "s", "b" },
		"a control character in the board": func(h *Header) { h.GuideBoard = "a\x01b" }, "a long board": func(h *Header) { h.GuideBoard = strings.Repeat("a", 129) },
	} {
		h := guideHeader()
		mut(&h)
		assert.Error(t, h.validate(l), name)
	}
	plain := Header{Kind: KindHTTP, Method: "GET", Path: "/api/health", GuideSince: guideSince}
	assert.Error(t, plain.validate(l), "a start with no guide role")
}

func TestWithHubGuideKeepsOnlyAWellFormedGuide(t *testing.T) {
	ctx := context.Background()
	_, ok := hubGuideFrom(WithHubGuide(ctx, "b", "nobody", guideSince))
	assert.False(t, ok)
	_, ok = hubGuideFrom(WithHubGuide(ctx, "b", guideLabel, ""))
	assert.False(t, ok)
	g, ok := hubGuideFrom(WithHubGuide(ctx, "b", guideLabel, guideSince))
	assert.True(t, ok)
	assert.Equal(t, HubGuide{Board: "b", Label: guideLabel, Since: guideSince}, g)
	assert.Equal(t, "", hubRoleFrom(WithHubRole(ctx, HubRoleGuide)), "the role alone, with no board, is not kept")
}

func TestTheGuideCapabilityIsDeclared(t *testing.T) {
	assert.Equal(t, "guide_role/1", CapGuideRole)
}

// End to end through a real stream: a guide reaches its table's routes with the stamp, a route outside the table and a WebSocket are refused before the computer's API, and a browser's copy of any header is dropped.
func TestAGuideStreamReachesOnlyTheGuideTable(t *testing.T) {
	var mu sync.Mutex
	var got []http.Header
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.Header.Clone())
		mu.Unlock()
		w.WriteHeader(200)
	})
	hub := newHub(t, fastCfg())
	launch := func() Mode { return TierLaunch }
	sess, _ := connect(t, hub, local, func(l *LocalHandler) {
		l.MaxMode = launch
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(launch)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	guide := WithHubGuide(WithHubTier(ctx, "launch"), guideBoard, guideLabel, guideSince)
	forged := http.Header{"X-Coral-Hub-Role": {"guide"}, "X-Coral-Hub-Guide-Board": {"other"}, "X-Coral-Hub-Guide-Label": {"hub-user-ffffffff"}}
	do := func(method, path string, c context.Context, hdr http.Header) (int, error) {
		req, _ := http.NewRequestWithContext(c, method, "http://x"+path, nil)
		for k, vs := range hdr {
			req.Header[k] = vs
		}
		resp, err := sess.RoundTrip(req)
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	code, err := do(http.MethodGet, "/api/board/dev%20team/messages", guide, forged)
	require.NoError(t, err)
	assert.Equal(t, 200, code)
	_, err = do(http.MethodGet, "/api/health", guide, nil)
	assert.Error(t, err, "a route outside the guide table never reaches the computer")
	_, err = do(http.MethodPost, "/api/sessions/launch", guide, nil)
	assert.Error(t, err)
	_, err = do(http.MethodGet, "/api/board/dev%20team/messages", WithHubTier(ctx, "launch"), forged)
	require.NoError(t, err, "no guide stamp: an ordinary viewer on an ordinary route")
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, got, 2)
	assert.Equal(t, "guide", got[0].Get(HubRoleHeader))
	assert.Equal(t, guideBoard, got[0].Get(HubGuideBoardHeader))
	assert.Equal(t, guideLabel, got[0].Get(HubGuideLabelHeader))
	assert.Equal(t, guideSince, got[0].Get(HubGuideSinceHeader))
	assert.Len(t, got[0].Values(HubRoleHeader), 1, "exactly one role header")
	assert.Empty(t, got[1].Get(HubRoleHeader), "a browser's role header is dropped")
	assert.Empty(t, got[1].Get(HubGuideBoardHeader))
	assert.Empty(t, got[1].Get(HubGuideLabelHeader))
}

// The revoke (#11457) is a route of the Hub's own service, not a person's: only a complete service stamp reaches it, a user (a viewer, an owner, a guide) at any tier does not, and a guide never reaches it.
func TestTheGuideRevokeIsAServiceRouteOnly(t *testing.T) {
	const path = "/api/cloud/guide-revoked"
	assert.True(t, IsServiceRoute(http.MethodPost, path))
	assert.False(t, IsServiceRoute(http.MethodGet, path))
	assert.False(t, IsGuideRoute(http.MethodPost, path), "a guide never reaches it")
	assert.Equal(t, TierNever, Classify(http.MethodPost, path, ""), "the user table refuses it at every tier")
	assert.NotEqual(t, TierNever, ClassifyService(http.MethodPost, path, ""))
	assert.Equal(t, TierView, ClassifyService(http.MethodPost, path, ""), "any mode takes it: it only takes proposals back")
}
