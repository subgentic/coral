package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// Through the real router: an agent's hook report whose text carries a sign-in link is stored, and what is stored has no token in it, for a
// plain link and for names with an escaped letter.
func TestAHookReportIsStoredWithoutTheTokenThroughTheRouter(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	const token = "S3cretTok3n"
	agentTok, err := srv.db.MintSessionToken(context.Background(), "sid-1", "agent-1") // the reports come from the agent's own hooks
	require.NoError(t, err)
	do := func(method, path, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, agentTok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	for i, summary := range []string{
		"printed http://127.0.0.1:8420/?login_token=" + token + "&x=1",
		"printed /?login%5Ftoken=" + token,
		"printed /?%6Cogin_token=" + token,
	} {
		code, out := do("POST", "/api/sessions/live/agent-1/events", `{"event_type":"tool_use","summary":"`+summary+`","session_id":"sid-1"}`)
		require.Less(t, code, 300, "report %d is kept: %s", i, out)
	}
	code, events := do("GET", "/api/sessions/live/agent-1/events?session_id=sid-1", "")
	require.Equal(t, http.StatusOK, code, events)
	assert.NotContains(t, events, token)
	assert.Equal(t, 3, strings.Count(events, `"tool_use"`), "all three reports are stored: %s", events)
}
