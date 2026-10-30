package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/server/routes"
)

// signInGuardedRoutes are the write routes whose body can carry text a person typed: each refuses a sign-in link's token (routes.RefuseSignInLink,
// the server side of #232). A route added to this list must be registered with r.With(routes.RefuseSignInLink); the test fails otherwise.
var signInGuardedRoutes = []string{
	"POST /api/notifications",
	"POST /api/saved",
	"PATCH /api/saved/{id}",
	"POST /api/board/remotes",
	"POST /api/board/{project}/subscribe",
	"PUT /api/board/{project}/settings",
	"POST /api/board/{project}/external-artifacts",
	"PATCH /api/board/{project}",
	"POST /api/board/{project}/groups/{groupID}/members",
	"POST /api/board/{project}/waits",
	"PUT /api/board/{project}/working-mode",
	"POST /api/board/{project}/cross-team-links",
	"POST /api/board/{project}/working-mode/presets",
	"PUT /api/board/{project}/working-mode/presets/{presetID}",
	"PUT /api/board/{project}/artifacts/{id}/tags",
	"PUT /api/board/{project}/subscribers/{subscriberID}/review-settings",
	"POST /api/board/{project}/tasks/{taskID}/review",
	"POST /api/board/{project}/tasks/{taskID}/attach",
	"POST /api/board/{project}/tasks/{taskID}/mark-landed",
	"POST /api/board/{project}/tasks/{taskID}/reassign",
	"POST /api/board/{project}/health/ack",
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
		path := strings.NewReplacer("{project}", "team", "{taskID}", "1", "{goalID}", "1", "{requestID}", "1", "{presetID}", "1", "{id}", "1",
			"{subscriberID}", "Lead", "{groupID}", "1").Replace(pattern)
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

// writeRoutesWithoutTheGuard are the write routes left without routes.RefuseSignInLink, each with why: their body carries no text a person
// typed. A new write route under these prefixes fails TestEveryWriteRouteIsGuardedOrSaysWhyNot until it is guarded or listed here.
var writeRoutesWithoutTheGuard = map[string]string{
	"DELETE /api/saved/{id}":                                           "a delete by id: no text is kept",
	"DELETE /api/board/remotes":                                        "a delete: no text is kept",
	"DELETE /api/board/{project}":                                      "a delete: no text is kept",
	"DELETE /api/board/{project}/subscribe":                            "a delete: no text is kept",
	"DELETE /api/board/{project}/messages/{messageID}":                 "a delete by id: no text is kept",
	"DELETE /api/board/{project}/groups/{groupID}/members/{sessionID}": "a delete by id: no text is kept",
	"DELETE /api/board/{project}/waits":                                "a delete: no text is kept",
	"DELETE /api/board/{project}/cross-team-links":                     "a delete: no text is kept",
	"DELETE /api/board/{project}/tasks/{taskID}/park":                  "a delete by id: no text is kept",
	"DELETE /api/board/{project}/tasks/{taskID}/reminder":              "a delete by id: no text is kept",
	"DELETE /api/board/{project}/reminder":                             "a delete: no text is kept",
	"POST /api/board/{project}/messages/mark-read":                     "ids only (subscriber_id, from_id, through_id)",
	"POST /api/board/{project}/pause":                                  "a switch: no text",
	"POST /api/board/{project}/resume":                                 "a switch: no text",
	"POST /api/board/{project}/cross-team/enable":                      "a switch: no text",
	"POST /api/board/{project}/cross-team/disable":                     "a switch: no text",
	"POST /api/board/{project}/cross-team/files/enable":                "a switch: no text",
	"POST /api/board/{project}/cross-team/files/disable":               "a switch: no text",
	"POST /api/board/{project}/working-mode/presets/{presetID}/reset":  "a reset to the default: no text",
	"PUT /api/board/{project}/tasks/{taskID}/goal":                     "ids only (goal_id)",
	"POST /api/board/{project}/tasks/claim":                            "ids only (subscriber_id, task_id)",
	"POST /api/board/{project}/tasks/current":                          "ids only (subscriber_id)",
	"POST /api/board/{project}/tasks/{taskID}/publish":                 "ids only (subscriber_id)",
	"POST /api/tasks/run":                                              "a one-shot task's prompt for an agent: not kept on a board",
	"POST /api/tasks/runs/{runID}/kill":                                "ids only",
}

// Every write route under the board, saved-item, notification and one-shot task prefixes either refuses a sign-in link (routes.RefuseSignInLink
// as its middleware) or is listed in writeRoutesWithoutTheGuard with why; the two lists agree with what the router serves.
func TestEveryWriteRouteIsGuardedOrSaysWhyNot(t *testing.T) {
	srv, _, _ := strictServer(t, false)
	guard := reflect.ValueOf(routes.RefuseSignInLink).Pointer()
	served := map[string]bool{}
	require.NoError(t, chi.Walk(srv.Router(), func(method, route string, _ http.Handler, mws ...func(http.Handler) http.Handler) error {
		switch method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		default:
			return nil
		}
		if !strings.HasPrefix(route, "/api/board/") && !strings.HasPrefix(route, "/api/saved") && route != "/api/notifications" && !strings.HasPrefix(route, "/api/tasks/") {
			return nil
		}
		key := method + " " + route
		served[key] = true
		guarded := false
		for _, mw := range mws {
			if reflect.ValueOf(mw).Pointer() == guard {
				guarded = true
			}
		}
		why, listed := writeRoutesWithoutTheGuard[key]
		switch {
		case guarded && listed:
			t.Errorf("%s is guarded but listed as not (%s)", key, why)
		case !guarded && !listed:
			t.Errorf("%s has no sign-in link guard and no reason in writeRoutesWithoutTheGuard: guard it (r.With(routes.RefuseSignInLink)) or say why its body carries no text", key)
		}
		return nil
	}))
	for key := range writeRoutesWithoutTheGuard {
		assert.True(t, served[key], "%s is listed but not served", key)
	}
	for _, key := range signInGuardedRoutes {
		if strings.HasPrefix(key, "POST /api/") || strings.HasPrefix(key, "PUT /api/") || strings.HasPrefix(key, "PATCH /api/") {
			assert.True(t, served[key], "%s is in signInGuardedRoutes but not served", key)
		}
	}
}
