package machinelaunch

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ Revoker = (*HubRevoker)(nil)

const (
	testChd = "chd_TESTDESTROY0123456789abcdef"
	testCID = "5b6c0f2e-0000-4000-8000-000000000001"
)

type hubStub struct {
	mu       sync.Mutex
	seen     []*http.Request
	bodies   []string
	answers  []func(w http.ResponseWriter)
	redirect string
}

func (h *hubStub) serve(t *testing.T) *HubRevoker {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		h.seen = append(h.seen, r.Clone(context.Background()))
		h.bodies = append(h.bodies, string(b))
		i := len(h.seen) - 1
		h.mu.Unlock()
		if h.redirect != "" {
			http.Redirect(w, r, h.redirect, http.StatusFound)
			return
		}
		if i >= len(h.answers) {
			i = len(h.answers) - 1
		}
		h.answers[i](w)
	}))
	t.Cleanup(srv.Close)
	return &HubRevoker{BaseURL: srv.URL, DestroyKey: testChd, Sleep: func(context.Context, time.Duration) error { return nil }}
}

func answer(status int, body string, hdr ...string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		for i := 0; i+1 < len(hdr); i += 2 {
			w.Header().Set(hdr[i], hdr[i+1])
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

// The request is exactly what coral-hub described: a POST to the credential's revoke path with one Authorization header, no body, no Origin, no cookie.
func TestRevokeSendsExactlyWhatTheHubDescribed(t *testing.T) {
	h := &hubStub{answers: []func(http.ResponseWriter){answer(200, `{"ok":true}`)}}
	r := h.serve(t)
	require.NoError(t, r.Revoke(t.Context(), testCID))
	require.Len(t, h.seen, 1)
	req := h.seen[0]
	assert.Equal(t, "POST", req.Method)
	assert.Equal(t, "/api/bootstrap/credentials/"+testCID+"/revoke", req.URL.Path)
	assert.Equal(t, []string{"Bearer " + testChd}, req.Header.Values("Authorization"), "exactly one Authorization header")
	assert.Empty(t, req.Header.Values("Origin"), "an Origin is a 403 at the Hub")
	assert.Empty(t, req.Header.Values("Cookie"))
	assert.Empty(t, h.bodies[0], "no body")
}

func TestRevokeIsIdempotentAndSaysEachRefusalPlainly(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int
		body   string
		kind   RevokeKind
		words  string
	}{
		{"revoked key: 401", 401, `{"error":"unauthorized"}`, RevokeUnauthorized, "did not accept the destroy credential"},
		{"unknown, another key's or non-UUID id: 404", 404, `{"error":"not_found"}`, RevokeNotFound, "does not know this machine's credential"},
		{"no revocation backend: 503 machine_revocation_unavailable", 503, `{"error":"machine_revocation_unavailable"}`, RevokeNotConfigured, "no machine revocation configured yet"},
		{"transient: 503 unavailable", 503, `{"error":"unavailable"}`, RevokeUnavailable, "NOT revoked"},
		{"another answer: 403 browser_origin", 403, `{"error":"browser_origin"}`, RevokeRefused, "HTTP 403"},
	} {
		h := &hubStub{answers: []func(http.ResponseWriter){answer(c.status, c.body)}}
		err := h.serve(t).Revoke(t.Context(), testCID)
		var re *RevokeError
		require.ErrorAs(t, err, &re, c.name)
		assert.Equal(t, c.kind, re.Kind, c.name)
		assert.Contains(t, err.Error(), c.words, c.name)
		assert.Contains(t, strings.ToLower(err.Error()), "not revoked", "a failed revoke says so: "+c.name)
		assert.NotContains(t, err.Error(), testChd, "the key is never in an error")
		assert.NotContains(t, err.Error(), c.body, "nor the Hub's body")
		if c.status == 401 || c.status == 404 || c.status == 403 {
			assert.Len(t, h.seen, 1, "%s is answered at once, not retried", c.name)
		}
	}
	// already revoked or consumed and ended: 200 again
	h := &hubStub{answers: []func(http.ResponseWriter){answer(200, `{"ok":true}`)}}
	r := h.serve(t)
	require.NoError(t, r.Revoke(t.Context(), testCID))
	require.NoError(t, r.Revoke(t.Context(), testCID))
}

// 429 waits what Retry-After says and tries again; a 503 is retried; both end when it works, or tell the person after the tries.
func TestRevokeRetriesRateLimitsAndTransient503s(t *testing.T) {
	var waits []time.Duration
	h := &hubStub{answers: []func(http.ResponseWriter){
		answer(429, `{"error":"rate_limited"}`, "Retry-After", "7"),
		answer(503, `{"error":"unavailable"}`),
		answer(429, ``, "Retry-After", "9999"),
		answer(200, `{"ok":true}`),
	}}
	r := h.serve(t)
	r.Sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	require.NoError(t, r.Revoke(t.Context(), testCID))
	assert.Len(t, h.seen, 4)
	assert.Equal(t, 7*time.Second, waits[0], "Retry-After is honoured")
	assert.Equal(t, 4*time.Second, waits[1], "a transient 503 backs off a little longer each time (2 s a try: this was the second)")
	assert.Equal(t, 2*time.Minute, waits[2], "a huge Retry-After is capped")

	// still limited after the tries
	h2 := &hubStub{answers: []func(http.ResponseWriter){answer(429, ``)}}
	r2 := h2.serve(t)
	r2.MaxTries = 3
	err := r2.Revoke(t.Context(), testCID)
	var re *RevokeError
	require.ErrorAs(t, err, &re)
	assert.Equal(t, RevokeRateLimited, re.Kind)
	assert.Len(t, h2.seen, 3, "it stopped after the tries")
}

// The destroy credential does not follow a redirect to another host, and a bad key or id is refused before anything is sent.
func TestRevokeSendsTheKeyToTheHubOnly(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the redirect was followed: %s carried %q", r.URL, r.Header.Get("Authorization"))
	}))
	defer other.Close()
	h := &hubStub{redirect: other.URL + "/steal", answers: []func(http.ResponseWriter){answer(200, ``)}}
	err := h.serve(t).Revoke(t.Context(), testCID)
	var re *RevokeError
	require.ErrorAs(t, err, &re, "a 302 is an answer this tool does not understand, not a place to go")
	assert.Equal(t, RevokeRefused, re.Kind)

	h2 := &hubStub{answers: []func(http.ResponseWriter){answer(200, ``)}}
	r := h2.serve(t)
	for _, key := range []string{"", "chk_TESTKEY0123456789", "tok en", "chd_x", "dop_v1_abcdef0123456789"} {
		r.DestroyKey = key
		assert.Error(t, r.Revoke(t.Context(), testCID), "key %q", key)
	}
	r.DestroyKey = testChd
	for _, id := range []string{"", "../x", "a/b", "short", strings.Repeat("a", 100)} {
		assert.Error(t, r.Revoke(t.Context(), id), "id %q", id)
	}
	assert.Empty(t, h2.seen, "nothing was sent")
	assert.Error(t, (&HubRevoker{BaseURL: "http://hub.example", DestroyKey: testChd}).Revoke(t.Context(), testCID), "plain http to a real host is refused")
}
