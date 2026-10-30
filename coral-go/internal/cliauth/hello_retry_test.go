package cliauth

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// helloServer answers the first undecided hellos "try again" (503 PeerUndecidedCode, closing the connection, as the server does) and
// then proves itself; or answers every hello with status/code. It counts the hellos and the connections they came on.
func helloServer(t *testing.T, token string, undecided int32, status int, code string) (*httptest.Server, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	a := NewCLIAuth(token)
	var hellos, conns atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != CLIHelloPath {
			w.WriteHeader(http.StatusOK)
			return
		}
		n := hellos.Add(1)
		if status != 0 || n <= undecided {
			st, cd := status, code
			if st == 0 {
				st, cd = http.StatusServiceUnavailable, PeerUndecidedCode
			}
			if cd == PeerUndecidedCode {
				w.Header().Set("Connection", "close")
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(st)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "\x1b]0;owned\x07\x1b[31mthe answer's own words", "code": cd})
			return
		}
		var b struct{ Nonce string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		sn, proof, err := a.Hello(b.Nonce)
		require.NoError(t, err)
		_ = json.NewEncoder(w).Encode(map[string]string{"nonce": sn, "proof": proof})
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			conns.Add(1)
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	return srv, &hellos, &conns
}

// #409: a hello answered "try again" because the server could not tell yet which OS user the connection is (the socket table can lag a
// connection) is sent again, on a new connection each time, so the server attributes it afresh. Twice undecided, then told: the request
// goes through. Still undecided after the retries: a fixed sentence, never the answer's text (until the hello is proved, any program on the
// port may have written it: here it carries terminal escapes). Another user's 403 is final, never retried.
func TestHelloRetriesAConnectionWhoseUserIsNotToldYet(t *testing.T) {
	old := helloRetryWait
	helloRetryWait = 10 * time.Millisecond
	t.Cleanup(func() { helloRetryWait = old })
	send := func(srv *httptest.Server) (*http.Response, error) {
		tr := &http.Transport{}
		t.Cleanup(tr.CloseIdleConnections)
		c := &http.Client{Transport: Transport{Base: tr, Token: "the-token"}}
		return c.Post(srv.URL+"/api/cloud/redeem", "application/json", strings.NewReader(`{"check":true}`))
	}

	srv, hellos, conns := helloServer(t, "the-token", 2, 0, "")
	resp, err := send(srv)
	require.NoError(t, err, "told on the third hello")
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.EqualValues(t, 3, hellos.Load())
	assert.GreaterOrEqual(t, conns.Load(), int32(3), "each retry came on a new connection")

	srv, hellos, _ = helloServer(t, "the-token", 100, 0, "")
	_, err = send(srv)
	var pu PeerUndecidedError
	require.True(t, errors.As(err, &pu), "%v", err)
	assert.Contains(t, err.Error(), PeerUndecidedError{}.Error(), "the fixed words (after the client's own prefix)")
	assert.NotContains(t, err.Error(), "\x1b", "no escape from the answer reaches the terminal")
	assert.NotContains(t, err.Error(), "own words")
	assert.EqualValues(t, helloRetries+1, hellos.Load(), "the first hello and helloRetries more, no further")

	srv, hellos, _ = helloServer(t, "the-token", 0, http.StatusForbidden, "other_user")
	_, err = send(srv)
	require.ErrorIs(t, err, ErrNotCoral, "another user's refusal is not retried")
	assert.EqualValues(t, 1, hellos.Load())
}
