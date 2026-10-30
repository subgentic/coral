package server

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// One sample URL per dashboard page family (#3532); every family in DashboardPagePaths must
// have one, so a family added without a test fails here.
var pageSamples = map[string]string{
	"/inbox/tasks":    "/inbox/tasks",
	"/inbox/tasks/*":  "/inbox/tasks/release-team/17",
	"/inbox/boards":   "/inbox/boards",
	"/inbox/boards/*": "/inbox/boards/release-team",
	"/inbox/goals":    "/inbox/goals",
	"/inbox/goals/*":  "/inbox/goals/release-team/17",
	"/inbox/*":        "/inbox/chats/starred",
	"/agents":         "/agents",
	"/agents/*":       "/agents/@m2/6f9a3c1e-0000-4000-8000-000000000001/files",
	"/chats":          "/chats?q=battle&page=2",
	"/chats/*":        "/chats/42",
	"/team/*":         "/team/@m2/coral-go-team/settings",
	"/board/*":        "/board/%40odd",
	"/workflows":      "/workflows",
	"/workflows/*":    "/workflows/7/runs/3",
	"/jobs":           "/jobs",
	"/jobs/*":         "/jobs/x",
	"/automations":    "/automations",
	"/automations/*":  "/automations/workflows/7/runs/3",
	"/analytics":      "/analytics",
	"/analytics/*":    "/analytics/provider",
	"/docs":           "/docs",
	"/docs/*":         "/docs/board",
	"/servers":        "/servers",
	"/servers/*":      "/servers/m2",
}

func pageGet(t *testing.T, c *http.Client, method, u string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, u, nil)
	resp, err := c.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

// Each page path serves exactly the shell "/" serves (GET only, same headers and ETag,
// Referrer-Policy same-origin), and nothing else changed: misses under /api, /ws, /auth and
// /static, and unknown paths, stay 404 and not HTML (no catch-all).
func TestDashboardPagePathsServeTheShell(t *testing.T) {
	for _, p := range DashboardPagePaths {
		_, ok := pageSamples[p]
		require.True(t, ok, "no sample URL for page family %s", p)
	}
	_, ts, _ := strictServer(t, false)
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	root, rootBody := pageGet(t, c, "GET", ts.URL+"/")
	require.Equal(t, 200, root.StatusCode)
	rootPost, _ := pageGet(t, c, "POST", ts.URL+"/")
	assert.Equal(t, "same-origin", root.Header.Get("Referrer-Policy"), "the shell sends Referrer-Policy")
	for fam, sample := range pageSamples {
		resp, body := pageGet(t, c, "GET", ts.URL+sample)
		assert.Equal(t, 200, resp.StatusCode, "%s (%s)", sample, fam)
		assert.True(t, strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html"), sample)
		assert.Equal(t, rootBody, body, "%s: the same shell as /", sample)
		assert.Equal(t, root.Header.Get("ETag"), resp.Header.Get("ETag"), "%s: the same ETag", sample)
		for _, h := range []string{"Referrer-Policy", "X-Frame-Options", "X-Content-Type-Options", "Content-Security-Policy"} {
			assert.Equal(t, root.Header.Get(h), resp.Header.Get(h), "%s: header %s as on /", sample, h)
		}
		post, _ := pageGet(t, c, "POST", ts.URL+sample)
		assert.Equal(t, rootPost.StatusCode, post.StatusCode, "%s: POST answers as on /", sample)
	}
	for _, miss := range []string{"/api/nope-3532", "/ws/nope", "/auth/nope", "/static/missing-3532.js", "/random-3532", "/inbox", "/agentsx", "/chat/x", "/history"} {
		resp, _ := pageGet(t, c, "GET", ts.URL+miss)
		assert.False(t, resp.StatusCode == 200 && strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html"), "%s must not get the shell (%d %s)", miss, resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

// With strict local auth, a signed-out page path is refused like "/" and the refusal keeps the
// path (and query) in return_to, so sign-in lands on the same view.
func TestDashboardPagePathsStrictKeepTheView(t *testing.T) {
	_, ts, _ := strictServer(t, true)
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	root, _ := pageGet(t, c, "GET", ts.URL+"/")
	for _, sample := range []string{"/inbox/tasks/release-team/17", "/inbox/boards/release-team", "/inbox/goals/release-team/17", "/team/@m2/coral-go-team/settings", "/chats?q=battle&page=2", "/agents/@m2/6f9a3c1e-0000-4000-8000-000000000001"} {
		resp, _ := pageGet(t, c, "GET", ts.URL+sample)
		assert.Equal(t, root.StatusCode, resp.StatusCode, "%s: refused like /", sample)
		loc, err := url.Parse(resp.Header.Get("Location"))
		require.NoError(t, err)
		assert.Equal(t, sample, loc.Query().Get("return_to"), "%s: return_to keeps the view", sample)
	}
}

// One canonical form (QA's nit on 1a): a trailing slash on any page path redirects 301 to the
// path without it, the query kept; bare /team and /board, which name no view, go to /agents.
func TestDashboardPagePathsCanonicalForm(t *testing.T) {
	_, ts, _ := strictServer(t, false)
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	cases := map[string]string{
		"/agents/":                          "/agents",
		"/chats/?q=battle&page=2":           "/chats?q=battle&page=2",
		"/workflows/":                       "/workflows",
		"/workflows/7/runs/3/":              "/workflows/7/runs/3",
		"/automations/jobs/4/":              "/automations/jobs/4",
		"/docs/":                            "/docs",
		"/servers/":                         "/servers",
		"/team/@m2/coral-go-team/settings/": "/team/@m2/coral-go-team/settings",
		"/team":                             "/agents",
		"/team/":                            "/agents",
		"/board":                            "/agents",
		"/board/?x=1":                       "/agents?x=1",
		"/agents//":                         "/agents",
		// The escaped form is kept exactly (QA and Security): a trailing slash never changes a link's meaning.
		"/board/%40odd/":  "/board/%40odd",
		"/team/%40m2/qa/": "/team/%40m2/qa",
		"/team/a%2Fb/":    "/team/a%2Fb",
		"/chats/a%3Fb/":   "/chats/a%3Fb",
		"/docs/x%23y/":    "/docs/x%23y",
		"/docs/x%20y/":    "/docs/x%20y",
	}
	for from, to := range cases {
		resp, _ := pageGet(t, c, "GET", ts.URL+from)
		assert.Equal(t, http.StatusMovedPermanently, resp.StatusCode, from)
		assert.Equal(t, to, resp.Header.Get("Location"), from)
	}
	for _, p := range []string{"/agents", "/chats?q=x", "/team/qa"} {
		resp, _ := pageGet(t, c, "GET", ts.URL+p)
		assert.Equal(t, 200, resp.StatusCode, "%s is already canonical", p)
	}
}

// #11237: the client router (pkg/frontend/static/routes.js) and this list must not drift: every first path word the router's parse() accepts has a family in DashboardPagePaths, so a route added to the router without a
// server entry fails here instead of showing "Page not found" on a reload. The one exception is the bare "/inbox", which is Coral Hub's own page (see DashboardPagePaths); the words the router does not know (/tasks, /goals,
// /artifacts, /knowledge, /home, /settings, /themes: nothing in the app links to them) stay a 404.
func TestEveryFirstWordTheClientRouterParsesIsServed(t *testing.T) {
	src, err := os.ReadFile("../../pkg/frontend/static/routes.js")
	require.NoError(t, err)
	text := string(src)
	start := strings.Index(text, "    switch (top) {")
	require.GreaterOrEqual(t, start, 0, "parse()'s switch on the first path word")
	end := strings.Index(text[start:], "\n    }\n")
	require.Greater(t, end, 0)
	body := text[start : start+end]
	words := map[string]bool{}
	caseRe := regexp.MustCompile(`case ([^:]+):`)
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "        case ") { // one level in: the switch's own cases
			continue
		}
		for _, m := range caseRe.FindAllStringSubmatch(line, -1) {
			w := strings.TrimSpace(m[1])
			switch {
			case w == "undefined" || w == "''":
				// the root
			case w == "INBOX":
				words["inbox"] = true
			case strings.HasPrefix(w, "'") && strings.HasSuffix(w, "'"):
				words[strings.Trim(w, "'")] = true
			}
		}
	}
	for _, w := range []string{"agents", "chats", "team", "board", "inbox", "workflows", "jobs", "automations", "analytics", "docs", "servers"} {
		require.True(t, words[w], "the census found the router's /%s (the parse of routes.js drifted?)", w)
	}
	served := map[string]bool{}
	for _, p := range DashboardPagePaths {
		served[strings.Split(strings.TrimPrefix(p, "/"), "/")[0]] = true
	}
	for w := range words {
		assert.True(t, served[w], "the client router parses /%s but DashboardPagePaths has no family for it: a reload of that page would be a 404", w)
	}
	for _, w := range []string{"tasks", "goals", "artifacts", "knowledge", "home", "settings", "themes"} {
		assert.False(t, words[w], "the router does not parse /%s", w)
	}
}
