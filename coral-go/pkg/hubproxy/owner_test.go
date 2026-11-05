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
			if req.Header.Get("X-Test-Session") == "1" {
				req = req.WithContext(WithSessionSignedIn(req.Context())) // the identity layer's dashboard cookie (routes.MountRemoteProxy)
			}
		}
		req.Header.Del("X-Test-Session")
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

// #13456: the signed-in owner's message to an agent is signed for that agent only, a message at the cap is signed, one over it is refused at the hub with a clear answer (never sent unstamped, which would
// make the person's words automation on the remote), and a grantee's send (not the signed-in owner) goes out unstamped and whole.
const sendPath = "/api/sessions/live/claude-abc/send"

func TestTheOwnersSendIsSignedForThatAgentOnly(t *testing.T) {
	hub, s := hubFor(t, ownerTestSecret)
	body := `{"command":"please send me a short summary","agent_type":"claude","session_id":"abc"}`
	post(t, hub, sendPath, body, true, nil)
	s.mu.Lock()
	defer s.mu.Unlock()
	stamp := s.header.Get(hubowner.Header)
	require.NotEmpty(t, stamp, "the owner's message to an agent was not signed")
	require.NoError(t, verifier().Verify(stamp, s.method, sendPath, s.target, []byte(s.body)))
	other := verifier()
	assert.Error(t, other.Verify(stamp, s.method, "/api/sessions/live/claude-xyz/send", "/api/sessions/live/claude-xyz/send", []byte(s.body)), "a stamp for one agent's send was accepted on another agent's")
}

func TestAGranteesSendIsNotSignedAndAnOwnersLongSendIsRefusedNotUnstamped(t *testing.T) {
	hub, s := hubFor(t, ownerTestSecret)
	atCap := `{"command":"` + strings.Repeat("x", hubowner.MaxBody-len(`{"command":""}`)) + `"}`
	require.Equal(t, hubowner.MaxBody, len(atCap))
	post(t, hub, sendPath, atCap, true, nil)
	s.mu.Lock()
	assert.NotEmpty(t, s.header.Get(hubowner.Header), "a message at the cap is signed")
	s.mu.Unlock()

	over := `{"command":"` + strings.Repeat("x", hubowner.MaxBody) + `"}`
	s.mu.Lock()
	s.body, s.header = "", nil
	s.mu.Unlock()
	req, _ := http.NewRequest("POST", hub.URL+"/api/remote/a"+sendPath, strings.NewReader(over))
	req.Header.Set("X-Test-Person", "1")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	assert.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode, "a long message from the owner is refused with a clear status")
	assert.Contains(t, string(b), `"not_sent":true`)
	assert.Contains(t, string(b), "too long")
	s.mu.Lock()
	assert.Empty(t, s.body, "nothing of the refused message reached the remote")
	s.mu.Unlock()

	post(t, hub, sendPath, over, false, nil) // a grantee: not the owner, never stamped, never refused here
	s.mu.Lock()
	defer s.mu.Unlock()
	assert.Empty(t, s.header.Get(hubowner.Header))
	assert.Equal(t, over, s.body, "a grantee's long message went through whole")
}

// Ignore and Undo of a question through our own hub (#13462): the signed-in person's close is signed for the remote to verify; the same request from an API key or an agent (no person) goes out unsigned, and a
// stamp is bound to that one question's close (the target), so it cannot be used on another question.
func TestTheSignedInPersonsIgnoreOfAQuestionIsSignedAndAnythingElseIsNot(t *testing.T) {
	const closePath = "/api/board/team/asks/42/close"
	hub, s := hubFor(t, ownerTestSecret)
	body := `{"note":"Dismissed by the operator"}`
	post(t, hub, closePath, body, true, nil)
	s.mu.Lock()
	stamp := s.header.Get(hubowner.Header)
	require.NotEmpty(t, stamp, "the person's Ignore was not signed")
	require.NoError(t, verifier().Verify(stamp, s.method, closePath, s.target, []byte(s.body)))
	assert.Error(t, verifier().Verify(stamp, s.method, "/api/board/team/asks/43/close", "/api/board/team/asks/43/close", []byte(s.body)), "one question's stamp is not another's")
	s.mu.Unlock()

	hub2, s2 := hubFor(t, ownerTestSecret)
	post(t, hub2, closePath, `{"undo":true}`, false, nil) // an API key or an agent at the hub, not the person
	s2.mu.Lock()
	assert.Empty(t, s2.header.Get(hubowner.Header), "a request that is not the signed-in person's is not signed")
	assert.Equal(t, `{"undo":true}`, s2.body)
	s2.mu.Unlock()
}

// The owner's change of a goal's driver and its move to another team through our own hub (#13517): the signed-in person's call is signed for the remote to verify, bound to that goal and that route; the same call from an API key or an
// agent goes out unsigned, and a stamp made for one goal's driver is no use for another goal or for its move.
func TestTheSignedInPersonsGoalDriverAndMoveAreSignedAndNothingElseIs(t *testing.T) {
	for _, c := range []struct{ path, body string }{
		{"/api/board/team/goals/7/driver", `{"driver":"dev-1"}`},
		{"/api/board/team/goals/7/move", `{"to_project":"other","driver":"dev-2"}`},
	} {
		hub, s := hubFor(t, ownerTestSecret)
		post(t, hub, c.path, c.body, true, nil)
		s.mu.Lock()
		stamp := s.header.Get(hubowner.Header)
		require.NotEmpty(t, stamp, "the person's %s was not signed", c.path)
		require.NoError(t, verifier().Verify(stamp, s.method, c.path, s.target, []byte(s.body)))
		assert.Error(t, verifier().Verify(stamp, s.method, "/api/board/team/goals/8"+strings.TrimPrefix(c.path, "/api/board/team/goals/7"), "/api/board/team/goals/8"+strings.TrimPrefix(c.path, "/api/board/team/goals/7"), []byte(s.body)), "one goal's stamp is not another goal's")
		s.mu.Unlock()

		hub2, s2 := hubFor(t, ownerTestSecret)
		post(t, hub2, c.path, c.body, false, nil) // an API key or an agent at the hub, not the person
		s2.mu.Lock()
		assert.Empty(t, s2.header.Get(hubowner.Header), "a request that is not the signed-in person's is not signed: "+c.path)
		assert.Equal(t, c.body, s2.body)
		s2.mu.Unlock()
	}
}
