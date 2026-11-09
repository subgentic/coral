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

// The request after a good hello can be refused the same way (the server checks a signed request's connection too, and a nonce is good for one request): it is answered 403 other_user, refused
// before the handler acts, so nothing was done. The helpers then repeat the pair, a new hello and the request, on a new connection, within the same bound.

// cliHelloWaits are the pauses before each repeat: 8 tries, 3 s in all at most (one table read took up to 1.34 s under load, #515).
var cliHelloWaits = []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 300 * time.Millisecond, 400 * time.Millisecond, 500 * time.Millisecond, 700 * time.Millisecond, 800 * time.Millisecond}

// cliDo is cli.Do, with a refused hello, or a request refused as another user's after its hello, sent again (cli.Do builds a new transport, so a new connection, on every call).
func cliDo(t *testing.T, cli cliauth.CLIClient, ctx context.Context, method, path string, body []byte, header http.Header, timeout time.Duration) (*http.Response, error) {
	t.Helper()
	resp, err := cli.Do(ctx, method, path, body, header, timeout)
	for _, wait := range cliHelloWaits {
		why := cliRefusedAsOther(resp, err)
		if why == "" {
			break
		}
		t.Logf("command-line request refused (%s); sending the hello and the request again in %v", why, wait)
		time.Sleep(wait)
		resp, err = cli.Do(ctx, method, path, body, header, timeout)
	}
	return resp, err
}

// cliRefusedAsOther says why a command-line answer is the owner check's refusal ("" when it is not): the hello refused (cliauth.ErrNotCoral), or the request answered 403 with code other_user.
// A refused response's body is read and closed; any other response is left as it was, its body still readable.
func cliRefusedAsOther(resp *http.Response, err error) string {
	if errors.Is(err, cliauth.ErrNotCoral) {
		return err.Error()
	}
	if err != nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		return ""
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if bytes.Contains(b, []byte(`"code":"other_user"`)) {
		return "403 " + string(bytes.TrimSpace(b))
	}
	resp.Body = io.NopCloser(bytes.NewReader(b))
	return ""
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
		why := cliRefusedAsOther(resp, err)
		if why == "" {
			break
		}
		c.t.Logf("command-line request refused (%s); sending the hello and the request again in %v", why, wait)
		time.Sleep(wait)
		resp, err = try()
	}
	return resp, err
}
