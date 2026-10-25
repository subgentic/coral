package coralproxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func reqFor(t *testing.T, raw string) *http.Request {
	t.Helper()
	r, err := http.NewRequest(http.MethodGet, raw, nil)
	require.NoError(t, err)
	return r
}

func clearProxyEnv(t *testing.T) {
	for _, n := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", Marker} {
		t.Setenv(n, "")
	}
}

func TestACodexProxyCarriesALoopbackRequestWhenCodexSaysItIsActive(t *testing.T) {
	clearProxyEnv(t)
	t.Setenv(Marker, "1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:43999")
	for _, target := range []string{"http://127.0.0.1:8420/api/board/x", "http://localhost:8420/", "http://[::1]:8420/", "http://127.0.0.2:8420/"} {
		u, err := Func(reqFor(t, target))
		require.NoError(t, err, target)
		require.NotNil(t, u, target)
		assert.Equal(t, "127.0.0.1:43999", u.Host, target)
	}
	// the lower-case and ALL_PROXY spellings are read too, in that order
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("http_proxy", "127.0.0.1:44000")
	u, _ := Func(reqFor(t, "http://127.0.0.1:8420/"))
	require.NotNil(t, u)
	assert.Equal(t, "127.0.0.1:44000", u.Host, "a bare host:port is an http proxy")
}

func TestWithoutCodexsMarkerAPersonsProxyIsNeverUsedForLoopback(t *testing.T) {
	clearProxyEnv(t)
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:43999") // set, but Codex did not say its proxy is active
	u, err := Func(reqFor(t, "http://127.0.0.1:8420/"))
	require.NoError(t, err)
	assert.Nil(t, u, "Go's own rule: no proxy for loopback")
	for _, off := range []string{"0", "false", "no", ""} {
		t.Setenv(Marker, off)
		u, _ = Func(reqFor(t, "http://127.0.0.1:8420/"))
		assert.Nil(t, u, "marker %q is not active", off)
	}
}

func TestAProxyThatIsNotOnThisComputerIsNeverGivenCorasRequest(t *testing.T) {
	clearProxyEnv(t)
	t.Setenv(Marker, "1")
	for _, bad := range []string{"http://proxy.example.invalid:3128", "http://10.0.0.5:3128", "socks5://127.0.0.1:1080", "http://", "://x", "http://user:pw@corp.example.invalid:8080"} {
		t.Setenv("HTTP_PROXY", bad)
		u, _ := Func(reqFor(t, "http://127.0.0.1:8420/"))
		assert.Nil(t, u, "the request carries Coral's session token: %q must not be used", bad)
	}
	// each name is tried in order and the first loopback proxy wins: a bad one before it is skipped, never used
	t.Setenv("HTTP_PROXY", "http://proxy.example.invalid:3128")
	t.Setenv("http_proxy", "http://127.0.0.1:43999")
	u, _ := Func(reqFor(t, "http://127.0.0.1:8420/"))
	require.NotNil(t, u)
	assert.Equal(t, "127.0.0.1:43999", u.Host)
}

func TestARequestToAnotherHostGoesTheNormalWay(t *testing.T) {
	clearProxyEnv(t)
	t.Setenv(Marker, "1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:43999")
	// a non-loopback target is decided by http.ProxyFromEnvironment, whatever it says (the person's own settings), never by the Codex branch
	want, wantErr := http.ProxyFromEnvironment(reqFor(t, "http://example.invalid/"))
	got, err := Func(reqFor(t, "http://example.invalid/"))
	assert.Equal(t, wantErr, err)
	assert.Equal(t, want, got)
}

// An end-to-end check: a client on the default transport reaches a "Coral" on loopback only through the stand-in Codex proxy, which sees an absolute-form request (no CONNECT).
func TestAClientReachesLoopbackThroughTheProxyOnTheDefaultTransport(t *testing.T) {
	clearProxyEnv(t)
	coral := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "coral said hi") }))
	defer coral.Close()
	var seen string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Method + " " + r.URL.String()
		resp, err := (&http.Client{Transport: &http.Transport{}}).Get(r.URL.String()) // the stand-in proxy forwards, as Codex's does for an allowed host (its own client: no proxy)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		_, _ = io.Copy(w, resp.Body)
	}))
	defer proxy.Close()
	pu, _ := url.Parse(proxy.URL)
	t.Setenv(Marker, "1")
	t.Setenv("HTTP_PROXY", "http://"+pu.Host)

	orig := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = orig })
	http.DefaultTransport = http.DefaultTransport.(*http.Transport).Clone()
	Install()
	resp, err := (&http.Client{}).Get(coral.URL + "/api/board/b/messages")
	require.NoError(t, err)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	assert.Equal(t, "coral said hi", string(body))
	assert.Equal(t, "GET "+coral.URL+"/api/board/b/messages", seen, "through the proxy, absolute form")

	// and without the marker the same client goes straight to Coral: the proxy sees nothing
	seen = ""
	t.Setenv(Marker, "")
	resp, err = (&http.Client{}).Get(coral.URL + "/x")
	require.NoError(t, err)
	resp.Body.Close()
	assert.Empty(t, seen, "no marker: direct")
}

func TestInstallLeavesAWrappedTransportAlone(t *testing.T) {
	orig := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = orig })
	wrapped := roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, nil })
	http.DefaultTransport = wrapped
	Install()
	_, ok := http.DefaultTransport.(roundTripFunc)
	assert.True(t, ok)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
