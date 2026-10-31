package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/store"
)

// Security's INFO a on #11450: the three settings that make an agent the Operator's Chief (chief_page, chief_team, chief_session) are the Operator's. An agent's token can neither write them nor
// change what /chief shows; the Operator's signed command line can.
func TestAnAgentTokenCannotWriteTheChiefSettings(t *testing.T) {
	srv, ts, dir := strictServer(t, true)
	ctx := context.Background()
	agentTok, err := srv.db.MintSessionToken(ctx, "sid-dev", "claude-dev")
	require.NoError(t, err)
	cliTok, err := cliauth.ReadToken(dir)
	require.NoError(t, err)
	cli := cliauth.CLIClient{Base: ts.URL, Token: cliTok}
	put := func(asAgent bool, body string) int {
		if !asAgent {
			resp, err := cli.Do(ctx, "PUT", "/api/settings", []byte(body), nil, 0)
			require.NoError(t, err)
			defer resp.Body.Close()
			io.Copy(io.Discard, resp.Body)
			return resp.StatusCode
		}
		req, _ := http.NewRequest("PUT", ts.URL+"/api/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, agentTok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}
	stored := func(key string) string {
		st, err := store.NewSessionStore(srv.db).GetSettings(ctx)
		require.NoError(t, err)
		return st[key]
	}
	for key, value := range map[string]string{"chief_page": `"true"`, "chief_team": `"chief"`, "chief_session": `"11111111-2222-4333-8444-555555555555"`} {
		assert.Equal(t, http.StatusForbidden, put(true, `{"`+key+`": `+value+`}`), "an agent token writing %s", key)
		assert.Empty(t, stored(key), "%s is not stored", key)
	}
	assert.Equal(t, http.StatusOK, put(false, `{"chief_team": "chief"}`), "the Operator's command line can")
	assert.Equal(t, "chief", stored("chief_team"))
}
