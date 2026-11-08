package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/cliauth"
)

// A command-line request opens a new loopback connection, and on Windows the server checks whose that connection is by reading the TCP table: once, again after 20 ms, then it refuses the
// connection as another user's. During a heavy test run the row can be missing for longer than that, so a test failed now and then on a check it does not test: its hello came back as "not this
// Coral" or as other_user (#515, #522). The helpers below send such a refused hello again, a bounded number of times, each on a new connection; the last refusal fails the test with its own
// message. A test that expects a refusal (another user, an old token) does not use them.

// cliHelloWaits are the pauses before each repeat: 7 tries, 2 s in all at most.
var cliHelloWaits = []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 300 * time.Millisecond, 400 * time.Millisecond, 500 * time.Millisecond, 500 * time.Millisecond}

// cliDo is cli.Do, with a refused hello sent again (cli.Do builds a new transport, so a new connection, on every call).
func cliDo(t *testing.T, cli cliauth.CLIClient, ctx context.Context, method, path string, body []byte, header http.Header, timeout time.Duration) (*http.Response, error) {
	t.Helper()
	resp, err := cli.Do(ctx, method, path, body, header, timeout)
	for _, wait := range cliHelloWaits {
		if !errors.Is(err, cliauth.ErrNotCoral) {
			break
		}
		t.Logf("command-line hello refused (%v); sending it again in %v", err, wait)
		time.Sleep(wait)
		resp, err = cli.Do(ctx, method, path, body, header, timeout)
	}
	return resp, err
}

// cliHTTPClient is an http.Client that signs as the command line does (cliauth.Transport) and sends a refused hello again, each try on a new connection.
func cliHTTPClient(t *testing.T, token, dir string) *http.Client {
	return &http.Client{Transport: cliRetryTransport{t: t, token: token, dir: dir}}
}

type cliRetryTransport struct {
	t          *testing.T
	token, dir string
}

func (c cliRetryTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
		r.Body.Close()
	}
	try := func() (*http.Response, error) {
		r2 := r.Clone(r.Context())
		r2.Body = io.NopCloser(bytes.NewReader(body))
		return cliauth.Transport{Base: &http.Transport{DisableKeepAlives: true}, Token: c.token, Dir: c.dir}.RoundTrip(r2)
	}
	resp, err := try()
	for _, wait := range cliHelloWaits {
		if !errors.Is(err, cliauth.ErrNotCoral) {
			break
		}
		c.t.Logf("command-line hello refused (%v); sending it again in %v", err, wait)
		time.Sleep(wait)
		resp, err = try()
	}
	return resp, err
}
