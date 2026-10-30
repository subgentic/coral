package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// signInGuardedRoutes are the board routes whose body is text other people read: each refuses a sign-in link's token (routes.RefuseSignInLink,
// the server side of #232). A route added to this list must be wrapped in router_board.go; the test fails otherwise.
var signInGuardedRoutes = []string{
	"POST /api/notifications",
	"POST /api/board/{project}/messages",
	"POST /api/board/{project}/external-messages",
	"POST /api/board/{project}/relay-messages",
	"POST /api/board/{project}/hub-notice",
	"POST /api/board/{project}/tasks",
	"PATCH /api/board/{project}/tasks/{taskID}",
	"PATCH /api/board/{project}/tasks/{taskID}/amend",
	"POST /api/board/{project}/tasks/{taskID}/complete",
	"POST /api/board/{project}/tasks/{taskID}/reply",
	"POST /api/board/{project}/tasks/{taskID}/submit-review",
	"POST /api/board/{project}/tasks/{taskID}/release-review",
	"POST /api/board/{project}/tasks/{taskID}/approve",
	"POST /api/board/{project}/tasks/{taskID}/reject",
	"POST /api/board/{project}/tasks/{taskID}/send-back",
	"POST /api/board/{project}/tasks/{taskID}/cancel",
	"POST /api/board/{project}/tasks/{taskID}/nudge",
	"POST /api/board/{project}/tasks/{taskID}/park",
	"POST /api/board/{project}/tasks/{taskID}/reminder",
	"POST /api/board/{project}/reminder",
	"POST /api/board/{project}/goals",
	"PATCH /api/board/{project}/goals/{goalID}",
	"POST /api/board/{project}/goals/{goalID}/close",
	"POST /api/board/{project}/goal-requests",
	"POST /api/board/{project}/goal-requests/{requestID}/accept",
	"POST /api/board/{project}/goal-requests/{requestID}/decline",
}

// Every listed route, called directly as a client that skips coral-board would, answers 400 sign_in_link for a body carrying a sign-in link,
// without the token in its answer; and a refused post is not stored, while the same post without the token is.
func TestTheBoardRoutesRefuseASignInLinkFromAnyClient(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	served := map[string]bool{}
	require.NoError(t, chi.Walk(srv.Router(), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		served[method+" "+route] = true
		return nil
	}))
	do := func(method, path, body string) (int, map[string]any, string) {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return resp.StatusCode, out, string(b)
	}
	const token = "S3cretTok3n"
	tainted := `{"subscriber_id":"Operator","as":"Operator","content":"see http://127.0.0.1:8420/?login_token=` + token + `","title":"t","body":"b","message":"m","reason":"r"}`
	for _, rt := range signInGuardedRoutes {
		require.True(t, served[rt], "%s is not a served route", rt)
		method, pattern, _ := strings.Cut(rt, " ")
		path := strings.NewReplacer("{project}", "team", "{taskID}", "1", "{goalID}", "1", "{requestID}", "1").Replace(pattern)
		code, out, raw := do(method, path, tainted)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %s", rt, raw)
		assert.Equal(t, "sign_in_link", out["code"], rt)
		assert.NotContains(t, raw, token, "%s repeats the token", rt)
	}

	_, err := srv.boardStore.Subscribe(context.Background(), "team", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	code, out, _ := do("POST", "/api/board/team/messages", `{"subscriber_id":"Operator","as":"Operator","content":"the result: 3 passed"}`)
	require.Equal(t, http.StatusOK, code, out)
	code, _, all := do("GET", "/api/board/team/messages/all", "")
	require.Equal(t, http.StatusOK, code)
	assert.Contains(t, all, "the result: 3 passed")
	assert.NotContains(t, all, token, "a refused post was stored")
}
