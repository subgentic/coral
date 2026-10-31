package hubproxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

const ownerTestSecret = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"

const reviewPath = "/api/board/team/artifacts/abc123/review"

// ownerHub is a hub whose routing marks a request as the signed-in person's when the test says so (the real mark is routes.MountRemoteProxy's, from the identity layer).
func ownerHub(t *testing.T, res *fakeResolver) *httptest.Server {
	t.Helper()
	h := New(res)
	r := chi.NewRouter()
	r.Handle("/api/remote/{server}/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("X-Test-Person") == "1" {
			req = req.WithContext(WithSignedInOwner(req.Context()))
		}
		req.Header.Del("X-Test-Person")
		h.ServeHTTP(w, req)
	}))
	hub := httptest.NewServer(r)
	t.Cleanup(hub.Close)
	return hub
}

type seenReq struct {
	mu     sync.Mutex
	header http.Header
	body   string
	target string
	method string
}

func (s *seenReq) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.header, s.body, s.method = r.Header.Clone(), string(b), r.Method
		s.target = r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			s.target += "?" + r.URL.RawQuery
		}
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	})
}

func post(t *testing.T, hub *httptest.Server, path, body string, person bool, extra map[string]string) {
	t.Helper()
	req, _ := http.NewRequest("POST", hub.URL+"/api/remote/a"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if person {
		req.Header.Set("X-Test-Person", "1")
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
}

// hubFor starts a remote that records what it received and a hub with server "a" pointing at it, with or without a secret.
func hubFor(t *testing.T, secret string) (*httptest.Server, *seenReq) {
	t.Helper()
	var s seenReq
	rem := httptest.NewServer(keyed(s.handler()))
	t.Cleanup(rem.Close)
	tg := HTTPTarget{URL: rem.URL, APIKey: remoteKey, AllowPrivate: true}
	if secret != "" {
		tg.OwnerSecret, tg.RemoteID = secret, "ssh-box"
	}
	return ownerHub(t, &fakeResolver{targets: map[string]HTTPTarget{"a": tg}, errs: map[string]error{}}), &s
}

func verifier() *hubowner.Verifier {
	return &hubowner.Verifier{Secret: ownerTestSecret, RemoteID: "ssh-box", Start: time.Now().Add(-time.Hour)}
}

func TestTheSignedInPersonsDecisionIsSignedForTheRemoteToVerify(t *testing.T) {
	hub, s := hubFor(t, ownerTestSecret)
	body := `{"decision":"approve"}`
	post(t, hub, "/api/board/team/artifacts/abc123/review?x=1", body, true, nil)
	s.mu.Lock()
	defer s.mu.Unlock()
	stamp := s.header.Get(hubowner.Header)
	require.NotEmpty(t, stamp, "the person's decision was not signed")
	assert.Equal(t, body, s.body, "the body reached the remote intact")
	assert.Equal(t, "Bearer "+remoteKey, s.header.Get("Authorization"), "the key is still the hub's own")
	// the remote verifies it against exactly what it received
	require.NoError(t, verifier().Verify(stamp, s.method, "/api/board/team/artifacts/abc123/review", s.target, []byte(s.body)))
	assert.Equal(t, reviewPath+"?x=1", s.target, "the stamp's target is the one sent")
}

func TestNothingIsSignedUnlessItIsThePersonsAllowedDecisionWithASecret(t *testing.T) {
	for name, c := range map[string]struct {
		secret string
		path   string
		person bool
	}{
		"not the person (an API key or an agent at the hub)": {ownerTestSecret, reviewPath, false},
		"a route off the allowlist":                          {ownerTestSecret, "/api/saved", true},
		"another decision route off the list":                {ownerTestSecret, "/api/board/team/artifacts/abc123/tags", true},
		"no secret for this server":                          {"", reviewPath, true},
	} {
		hub, s := hubFor(t, c.secret)
		post(t, hub, c.path, `{"decision":"approve"}`, c.person, nil)
		s.mu.Lock()
		assert.Empty(t, s.header.Get(hubowner.Header), name)
		assert.Equal(t, `{"decision":"approve"}`, s.body, name+": the body arrived")
		s.mu.Unlock()
	}
}

func TestAStampFromTheBrowserNeverReachesTheRemote(t *testing.T) {
	hub, s := hubFor(t, ownerTestSecret)
	forged := "v1.1793361601." + strings.Repeat("0", 32) + "." + strings.Repeat("0", 64)
	post(t, hub, "/api/board/team/artifacts/abc123/tags", `{}`, false, map[string]string{hubowner.Header: forged})
	s.mu.Lock()
	assert.Empty(t, s.header.Get(hubowner.Header), "a browser's stamp on a route that gets none went through")
	s.mu.Unlock()
	// on a route that IS signed, the hub's own stamp replaces whatever the browser sent
	post(t, hub, reviewPath, `{"decision":"approve"}`, true, map[string]string{hubowner.Header: forged})
	s.mu.Lock()
	defer s.mu.Unlock()
	got := s.header.Get(hubowner.Header)
	assert.NotEqual(t, forged, got)
	assert.Len(t, s.header.Values(hubowner.Header), 1, "one stamp, the hub's")
	require.NoError(t, verifier().Verify(got, s.method, "/api/board/team/artifacts/abc123/review", s.target, []byte(s.body)))
}

func TestABodyTooLargeToStampIsSentWholeAndUnstamped(t *testing.T) {
	hub, s := hubFor(t, ownerTestSecret)
	big := `{"decision":"approve","note":"` + strings.Repeat("x", hubowner.MaxBody) + `"}`
	post(t, hub, reviewPath, big, true, nil)
	s.mu.Lock()
	defer s.mu.Unlock()
	assert.Empty(t, s.header.Get(hubowner.Header), "a body over the cap was stamped")
	assert.Equal(t, big, s.body, "a big body was cut or changed on its way")
}

func TestTheSecretIsNeverSentToTheRemoteOrBack(t *testing.T) {
	hub, s := hubFor(t, ownerTestSecret)
	req, _ := http.NewRequest("POST", hub.URL+"/api/remote/a"+reviewPath, strings.NewReader(`{"decision":"approve"}`))
	req.Header.Set("X-Test-Person", "1")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	assert.NotContains(t, string(b), ownerTestSecret)
	for k, v := range resp.Header {
		assert.NotContains(t, strings.Join(v, ","), ownerTestSecret, k)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.header {
		assert.NotContains(t, strings.Join(v, ","), ownerTestSecret, "the secret itself reached the remote in "+k)
	}
	assert.NotContains(t, s.body, ownerTestSecret)
}
