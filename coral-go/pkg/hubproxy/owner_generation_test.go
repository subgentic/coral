package hubproxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #13725 (the Hub side of #13694): a WIDENED route (generation 2: every Operator click that writes an Activity row, and the person-gated decisions outside it) is signed only for a person who holds a sign-in session at this
// hub, and only for a remote whose health answer says it accepts generation 2. An older remote gets the click UNSTAMPED, as before, never refused; the original eight are signed as they always were.

const completePath = "/api/board/team/tasks/5/complete" // generation 2

// remoteAt is a remote whose /api/health says it accepts allowlist generation gen (0: the field is absent, an older Coral; -1: health answers 500), recording what else it receives.
func remoteAt(t *testing.T, gen int) (*httptest.Server, *seenReq, *atomic.Int32) {
	t.Helper()
	var s seenReq
	var health atomic.Int32
	inner := s.handler()
	rem := httptest.NewServer(keyed(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			health.Add(1)
			switch {
			case gen < 0:
				w.WriteHeader(http.StatusInternalServerError)
			case gen == 0:
				_, _ = io.WriteString(w, `{"status":"ok","version":"2.0.53"}`)
			default:
				_, _ = io.WriteString(w, `{"status":"ok","version":"2.0.54","hub_owner_routes":`+string(rune('0'+gen))+`}`)
			}
			return
		}
		inner.ServeHTTP(w, r)
	})))
	t.Cleanup(rem.Close)
	return rem, &s, &health
}

func hubOver(t *testing.T, rem *httptest.Server) *httptest.Server {
	t.Helper()
	tg := HTTPTarget{URL: rem.URL, APIKey: remoteKey, AllowPrivate: true, OwnerSecret: ownerTestSecret, RemoteID: "ssh-box"}
	return ownerHub(t, &fakeResolver{targets: map[string]HTTPTarget{"a": tg}, errs: map[string]error{}})
}

var person = map[string]string{"X-Test-Session": "1"}

func TestAWidenedClickIsSignedForASignedInSessionAndARemoteThatAcceptsIt(t *testing.T) {
	rem, s, _ := remoteAt(t, 2)
	hub := hubOver(t, rem)
	post(t, hub, completePath, `{"note":"done"}`, true, person)
	s.mu.Lock()
	defer s.mu.Unlock()
	stamp := s.header.Get(hubowner.Header)
	require.NotEmpty(t, stamp, "a widened click of a signed-in session on a generation 2 remote is signed")
	require.NoError(t, verifier().Verify(stamp, s.method, completePath, s.target, []byte(s.body)))
}

func TestAnOlderRemoteGetsTheWidenedClickUnstampedNotRefused(t *testing.T) {
	for name, gen := range map[string]int{"generation 1": 1, "no field (an older Coral)": 0, "health answers 500": -1} {
		rem, s, health := remoteAt(t, gen)
		hub := hubOver(t, rem)
		post(t, hub, completePath, `{"note":"done"}`, true, person) // post requires a 200: not refused
		s.mu.Lock()
		assert.Empty(t, s.header.Get(hubowner.Header), name+": not signed")
		assert.Equal(t, `{"note":"done"}`, s.body, name+": the click arrived whole")
		s.mu.Unlock()
		assert.EqualValues(t, 1, health.Load(), name+": the remote was asked once")
	}
}

func TestAWidenedClickIsNotSignedWithoutASignInSession(t *testing.T) {
	rem, s, health := remoteAt(t, 2)
	hub := hubOver(t, rem)
	post(t, hub, completePath, `{"note":"done"}`, true, nil) // the owner of a hub with sign-in off: this computer's own browser
	s.mu.Lock()
	assert.Empty(t, s.header.Get(hubowner.Header), "no sign-in session: not signed")
	s.mu.Unlock()
	assert.EqualValues(t, 0, health.Load(), "and the remote was not even asked")
	post(t, hub, completePath, `{"note":"done"}`, false, person) // a session mark without the person (it cannot happen in the hub; pinned)
	s.mu.Lock()
	assert.Empty(t, s.header.Get(hubowner.Header), "not the person: not signed")
	s.mu.Unlock()
}

func TestTheOriginalEightAreSignedWithOrWithoutASessionAndWithoutAskingTheRemote(t *testing.T) {
	for name, extra := range map[string]map[string]string{"with a session": person, "sign-in off": nil} {
		rem, s, health := remoteAt(t, 1)
		hub := hubOver(t, rem)
		post(t, hub, reviewPath, `{"decision":"approve"}`, true, extra)
		s.mu.Lock()
		assert.NotEmpty(t, s.header.Get(hubowner.Header), name+": the review decision is signed")
		s.mu.Unlock()
		assert.EqualValues(t, 0, health.Load(), name+": no health read for a generation 1 route")
	}
}

func TestTheRemotesGenerationIsKeptForAMinute(t *testing.T) {
	rem, _, health := remoteAt(t, 2)
	hub := hubOver(t, rem)
	for i := 0; i < 3; i++ {
		post(t, hub, completePath, `{"n":1}`, true, person)
	}
	assert.EqualValues(t, 1, health.Load(), "three widened clicks, one health read")
}

func TestAnOversizeWidenedClickIsRefusedOnlyWhereItWouldHaveBeenSigned(t *testing.T) {
	big := `{"note":"` + strings.Repeat("x", hubowner.MaxBody) + `"}`
	post2 := func(hub *httptest.Server) int {
		req, _ := http.NewRequest("POST", hub.URL+"/api/remote/a"+completePath, strings.NewReader(big))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-Person", "1")
		req.Header.Set("X-Test-Session", "1")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	rem2, _, _ := remoteAt(t, 2)
	assert.Equal(t, http.StatusRequestEntityTooLarge, post2(hubOver(t, rem2)), "a generation 2 remote: refused whole, never sent with a lesser identity")
	rem1, s1, _ := remoteAt(t, 1)
	assert.Equal(t, http.StatusOK, post2(hubOver(t, rem1)), "an older remote: unstamped as before, not refused")
	s1.mu.Lock()
	assert.Empty(t, s1.header.Get(hubowner.Header))
	s1.mu.Unlock()
}

