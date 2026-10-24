package routes

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

// CodeQL #490 (#7290): the board proxy builds the URL it asks a registered remote for from a project that urlParam has percent-DECODED. These tests send what an attacker sends through the real routes and
// look at what the remote is asked.
type remoteProxyEnv struct {
	t      *testing.T
	h      *BoardRemotesHandler
	router http.Handler
	remote string // the registered remote's URL
	mu     sync.Mutex
	asked  []string // "path?query" of every request the remote received
}

func newRemoteProxyEnv(t *testing.T) *remoteProxyEnv {
	e := &remoteProxyEnv{t: t}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		e.asked = append(e.asked, r.URL.RequestURI())
		e.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(remote.Close)
	e.remote = remote.URL
	db, err := storetest.Open(t, t.TempDir()+"/remote.db")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	e.h = NewBoardRemotesHandler(db, &config.Config{})
	e.h.resolve = func(string) (string, error) { return "127.0.0.1", nil } // the test remote is on loopback, which the real check refuses
	_, err = e.h.rbs.AddRemoteSub(t.Context(), "sid", remote.URL, "proj", "Dev")
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Get("/api/board/remotes/proxy/{remoteServer}/projects", e.h.ProxyProjects)
	r.Get("/api/board/remotes/proxy/{remoteServer}/{project}/messages/all", e.h.ProxyMessages)
	r.Get("/api/board/remotes/proxy/{remoteServer}/{project}/subscribers", e.h.ProxySubscribers)
	r.Get("/api/board/remotes/proxy/{remoteServer}/{project}/messages/check", e.h.ProxyCheckUnread)
	e.router = r
	return e
}

func (e *remoteProxyEnv) get(rawPath string) (int, string) {
	e.t.Helper()
	req := httptest.NewRequest("GET", "http://x"+rawPath, nil)
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func (e *remoteProxyEnv) lastAsked() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.asked...)
}

func TestRemoteProxyKeepsTheProjectInsideApiBoard(t *testing.T) {
	e := newRemoteProxyEnv(t)
	srv := url.PathEscape(e.remote)
	base := "/api/board/remotes/proxy/" + srv
	// an ordinary project works, on every proxy route, and the remote is asked for /api/board/<project>/...
	for _, c := range []struct{ route, want string }{
		{"/proj/messages/all?limit=5", "/api/board/proj/messages/all?limit=5"},
		{"/proj/subscribers", "/api/board/proj/subscribers"},
		{"/proj/messages/check?subscriber_id=a%26b", "/api/board/proj/messages/check?subscriber_id=a%26b"},
	} {
		code, body := e.get(base + c.route)
		require.Equal(t, 200, code, c.route+": "+body)
		got := e.lastAsked()
		assert.Equal(t, c.want, got[len(got)-1], c.route)
	}
	asked := len(e.lastAsked())

	// what an attacker sends: a decoded slash, "..", a query, a fragment, a backslash, a control character, an empty or dot name
	for _, bad := range []string{
		"..%2F..%2Fsessions%3Fx%3D", "..%2F..%2F..%2Fapi%2Fsettings", "%2E%2E", "..", ".", "a%2Fb", "a%3Fb%3Dc", "a%23b", "a%5Cb", "a%00b", "a%0Ab", "a%0Db", "%2F",
	} {
		for _, tail := range []string{"/messages/all?limit=5", "/subscribers", "/messages/check?subscriber_id=x"} {
			code, body := e.get(base + "/" + bad + tail)
			assert.Equal(t, 400, code, bad+tail+": "+body)
		}
	}
	assert.Len(t, e.lastAsked(), asked, "no refused project reached the remote")

	// a name with a space or a dot is a real board name that older boards keep: it goes as ONE escaped segment
	code, body := e.get(base + "/Old%20Team%20v1.2/subscribers")
	require.Equal(t, 200, code, body)
	got := e.lastAsked()
	assert.Equal(t, "/api/board/Old%20Team%20v1.2/subscribers", got[len(got)-1])
	// a name that holds a percent sign is escaped, not sent as the start of an escape
	for _, route := range []string{"/messages/all?limit=5", "/subscribers", "/messages/check?subscriber_id=x"} {
		code, body = e.get(base + "/100%25%20done" + route)
		require.Equal(t, 200, code, route+": "+body)
		got = e.lastAsked()
		assert.Contains(t, got[len(got)-1], "/api/board/100%25%20done/", route)
	}
}

func TestRemoteProxyTalksToTheRegisteredServerOnly(t *testing.T) {
	e := newRemoteProxyEnv(t)
	// not registered: refused, nothing asked
	other := url.PathEscape("http://127.0.0.1:1")
	code, _ := e.get("/api/board/remotes/proxy/" + other + "/proj/subscribers")
	assert.Equal(t, 403, code)
	assert.Empty(t, e.lastAsked())
	// registered with a trailing slash in the request: still the registered server
	code, body := e.get("/api/board/remotes/proxy/" + url.PathEscape(e.remote+"/") + "/proj/subscribers")
	assert.Equal(t, 200, code, body)
	// the projects route: the registered server by its segment
	code, body = e.get("/api/board/remotes/proxy/" + url.PathEscape(e.remote) + "/projects")
	assert.Equal(t, 200, code, fmt.Sprint(body))
	got := e.lastAsked()
	assert.Equal(t, "/api/board/projects", got[len(got)-1])
}

func TestRemoteProxyBuildsAValidURLForAnIPv6Remote(t *testing.T) {
	assert.Equal(t, "http://[2001:db8::1]:8420/api/board/p/subscribers", pinnedRemoteURL("http", "2001:db8::1", "8420", "/p/subscribers"))
	assert.Equal(t, "https://203.0.113.9:443/api/board/projects", pinnedRemoteURL("https", "203.0.113.9", "443", "/projects"))
	u, err := url.Parse(pinnedRemoteURL("http", "::1", "80", "/p/messages/all?limit=5"))
	require.NoError(t, err, "the IPv6 URL parses")
	assert.Equal(t, "::1", u.Hostname())
	assert.Equal(t, "80", u.Port())
	assert.Equal(t, "[::1]", hostHeader("::1"))
	assert.Equal(t, "example.com", hostHeader("example.com"))
}
