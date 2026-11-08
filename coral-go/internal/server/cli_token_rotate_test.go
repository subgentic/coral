package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #4041 (Security's #4039 finding 4): coral reset-password also replaces the command-line
// token, so whatever read the old one can no longer sign as the Operator; the command line
// (which reads the token file) keeps working.
func TestResetPasswordRotatesTheCLIToken(t *testing.T) {
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	cfg.StrictLocalAuth = true
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := mustServer(NewWithKey(cfg, db, stack.backend, stack.terminal, ""))
	t.Cleanup(srv.Close)
	local := httptest.NewServer(srv.Router())
	t.Cleanup(local.Close)
	ctx := context.Background()

	old, err := cloud.ReadCLIToken(cfg.CoralDir())
	require.NoError(t, err)
	// status signs one request with tok. retry sends a refused hello again (cliDo) for a token that should sign; the old token's expected refusal is asked once, with no retry.
	status := func(tok string, retry bool) (int, error) {
		cli := cloud.CLIClient{Base: local.URL, Token: tok}
		var resp *http.Response
		var err error
		if retry {
			resp, err = cliDo(t, cli, ctx, http.MethodGet, "/api/sessions/live", nil, nil, 5*time.Second)
		} else {
			resp, err = cli.Do(ctx, http.MethodGet, "/api/sessions/live", nil, nil, 5*time.Second)
		}
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	code, err := status(old, true)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, code, "the token signs before the reset")

	resp, err := cliDo(t, cloud.CLIClient{Base: local.URL, Token: old}, ctx, http.MethodPost, "/api/auth/password/reset", []byte(`{"password":"a new one"}`), nil, 30*time.Second)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	fresh, err := cloud.ReadCLIToken(cfg.CoralDir())
	require.NoError(t, err)
	assert.NotEqual(t, old, fresh, "a new token was written")
	_, err = status(old, false)
	assert.ErrorIs(t, err, cliauth.ErrNotCoral, "the old token no longer signs")
	code, err = status(fresh, true)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, code, "the new token signs")

	// A long-running tool that read the old token at its start reads the new one, once.
	c := &http.Client{Transport: cliauth.Transport{Base: http.DefaultTransport, Token: old, Dir: cfg.CoralDir()}}
	r2, err := c.Get(local.URL + "/api/sessions/live")
	require.NoError(t, err)
	r2.Body.Close()
	assert.Equal(t, http.StatusOK, r2.StatusCode)
}

// #4041: a coral command from before the query was signed (its MAC leaves the query out) is
// refused on a request with a query, and the refusal says to use the coral of this version.
func TestOlderCLISignatureIsRefusedWithAnUpdateHint(t *testing.T) {
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	cfg.StrictLocalAuth = true
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := mustServer(NewWithKey(cfg, db, stack.backend, stack.terminal, ""))
	t.Cleanup(srv.Close)
	local := httptest.NewServer(srv.Router())
	t.Cleanup(local.Close)
	tok, err := cloud.ReadCLIToken(cfg.CoralDir())
	require.NoError(t, err)

	send := func(sig string) (int, string) {
		req, err := http.NewRequest("GET", local.URL+"/api/sessions/live?limit=5", nil)
		require.NoError(t, err)
		req.Header.Set(cliauth.CLIAuthHeader, sig)
		resp, err := (&http.Client{Transport: &http.Transport{DisableKeepAlives: true}}).Do(req) // a new connection per request: the owner check is per connection
		require.NoError(t, err)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(b)
	}
	// signed signs path (a new hello each time) and sends the request; a request refused as another user's (the owner check missed its connection under load, #522) is signed and sent again,
	// within cliHelloWaits. The final answer is the one asserted, and this test never expects other_user.
	signed := func(path string) (int, string) {
		code, body := send(cliSignServer(t, local.URL, tok, "GET", path, ""))
		for _, wait := range cliHelloWaits {
			if code != http.StatusForbidden || !strings.Contains(body, `"code":"other_user"`) {
				break
			}
			t.Logf("signed request refused (%s); signing and sending it again in %v", strings.TrimSpace(body), wait)
			time.Sleep(wait)
			code, body = send(cliSignServer(t, local.URL, tok, "GET", path, ""))
		}
		return code, body
	}
	code, body := signed("/api/sessions/live") // the old MAC: no query
	assert.Equal(t, http.StatusUnauthorized, code)
	assert.Contains(t, body, "cli_signature_required")
	assert.Contains(t, body, "Use the coral command that came with this Coral")
	code, _ = signed("/api/sessions/live?limit=5")
	assert.Equal(t, http.StatusOK, code, "this version's signature")
}
