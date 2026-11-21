package routes

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func tlsRevoker(ts *httptest.Server) *httpRevoker {
	c := ts.Client()
	return newHTTPRevoker(func() bool { return true }, c)
}

// #20346, Hub terms (a)-(d): exactly {server_id, reason}, the link's own token as the bearer, no query string, the Hub's answer read as one state word.
func TestHubRevokeSendsExactlyTheAgreedCall(t *testing.T) {
	var gotPath, gotAuth, gotBody, gotQuery, gotCT, gotMethod string
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotQuery, gotCT, gotMethod = r.URL.Path, r.Header.Get("Authorization"), r.URL.RawQuery, r.Header.Get("Content-Type"), r.Method
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		io.WriteString(w, `{"ok":true,"state":"removed"}`)
	}))
	defer ts.Close()
	res := tlsRevoker(ts).Revoke(context.Background(), ts.URL, "srv_1", "tok-secret")
	assert.Equal(t, RevokeRemoved, res.Answer)
	assert.Equal(t, "POST", gotMethod)
	assert.Equal(t, "/api/servers/self/unlink", gotPath)
	assert.Equal(t, "Bearer tok-secret", gotAuth)
	assert.Empty(t, gotQuery)
	assert.Equal(t, "application/json", gotCT)
	assert.JSONEq(t, `{"server_id":"srv_1","reason":"removed-here"}`, gotBody)
}

func TestHubRevokeAnswers(t *testing.T) {
	for name, c := range map[string]struct {
		status int
		body   string
		hdr    map[string]string
		want   RevokeAnswer
		after  time.Duration
	}{
		"removed":          {200, `{"ok":true,"state":"removed"}`, nil, RevokeRemoved, 0},
		"already gone":     {200, `{"ok":true,"state":"already_gone"}`, nil, RevokeAlreadyGone, 0},
		"unknown state":    {200, `{"ok":true,"state":"something else"}`, nil, RevokeRetry, 0},
		"not json":         {200, `<html>`, nil, RevokeRetry, 0},
		"not found":        {404, ``, nil, RevokeNotFound, 0},
		"token refused":    {401, ``, nil, RevokeTokenRefused, 0},
		"forbidden":        {403, ``, nil, RevokeForbidden, 0},
		"our bug":          {400, `{"error":"bad"}`, nil, RevokeBadRequest, 0},
		"busy":             {429, ``, map[string]string{"Retry-After": "120"}, RevokeRetry, 120 * time.Second},
		"busy no header":   {429, ``, nil, RevokeRetry, 0},
		"busy huge":        {429, ``, map[string]string{"Retry-After": "99999999"}, RevokeRetry, 24 * time.Hour},
		"busy junk":        {429, ``, map[string]string{"Retry-After": "soon"}, RevokeRetry, 0},
		"server error":     {503, ``, nil, RevokeRetry, 0},
		"redirect refused": {302, ``, map[string]string{"Location": "https://elsewhere.invalid/"}, RevokeRetry, 0},
	} {
		t.Run(name, func(t *testing.T) {
			ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for k, v := range c.hdr {
					w.Header().Set(k, v)
				}
				w.WriteHeader(c.status)
				io.WriteString(w, c.body)
			}))
			defer ts.Close()
			res := tlsRevoker(ts).Revoke(context.Background(), ts.URL, "srv_1", "tok")
			assert.Equal(t, c.want, res.Answer)
			assert.Equal(t, c.after, res.RetryAfter)
		})
	}
}

// A redirect is never followed: the token would go to another origin.
func TestHubRevokeNeverFollowsARedirect(t *testing.T) {
	var elsewhere int32
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { atomic.AddInt32(&elsewhere, 1) }))
	defer other.Close()
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/api/servers/self/unlink", http.StatusTemporaryRedirect)
	}))
	defer ts.Close()
	res := tlsRevoker(ts).Revoke(context.Background(), ts.URL, "srv_1", "tok")
	assert.Equal(t, RevokeRetry, res.Answer)
	assert.Zero(t, atomic.LoadInt32(&elsewhere), "the token never reached another origin")
}

// The call is dark until its switch is on: no request at all, and the answer is "no call yet".
func TestHubRevokeIsDarkUntilSwitchedOn(t *testing.T) {
	var hits int32
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { atomic.AddInt32(&hits, 1) }))
	defer ts.Close()
	r := newHTTPRevoker(func() bool { return false }, ts.Client())
	assert.Equal(t, RevokeUnsupported, r.Revoke(context.Background(), ts.URL, "srv_1", "tok").Answer)
	assert.Zero(t, atomic.LoadInt32(&hits))
}

// Plain http, a path or a query in the stored origin, or a Hub whose certificate does not verify, never gets the token.
func TestHubRevokeRefusesWhatIsNotAVerifiedHTTPSOrigin(t *testing.T) {
	var hits int32
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { atomic.AddInt32(&hits, 1) }))
	defer ts.Close()
	r := tlsRevoker(ts)
	for _, o := range []string{strings.Replace(ts.URL, "https://", "http://", 1), ts.URL + "/x", ts.URL + "?a=1", "ftp://x", ""} {
		assert.Equal(t, RevokeRetry, r.Revoke(context.Background(), o, "srv_1", "tok").Answer, o)
	}
	assert.Zero(t, atomic.LoadInt32(&hits))
	// the default client trusts the system roots only: the test server's own certificate is refused
	def := newHTTPRevoker(func() bool { return true }, nil)
	assert.Equal(t, RevokeRetry, def.Revoke(context.Background(), ts.URL, "srv_1", "tok").Answer)
	assert.Zero(t, atomic.LoadInt32(&hits))
	_ = tls.VersionTLS12
}

// An answer is read to 1 KB only.
func TestHubRevokeReadsAtMostOneKB(t *testing.T) {
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"state":"removed","pad":"`+strings.Repeat("x", 5000)+`"}`)
	}))
	defer ts.Close()
	assert.Equal(t, RevokeRetry, tlsRevoker(ts).Revoke(context.Background(), ts.URL, "srv_1", "tok").Answer, "a truncated answer is not one the Hub gave")
}
