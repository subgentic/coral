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
	"PATCH /api/board/{project}",
	"POST /api/board/{project}/groups/{groupID}/members",
	"POST /api/board/{project}/waits",
	"PUT /api/board/{project}/working-mode",
	"POST /api/board/{project}/cross-team-links",
	"POST /api/board/{project}/working-mode/presets",
	"PUT /api/board/{project}/working-mode/presets/{presetID}",
	"PUT /api/board/{project}/artifacts/{id}/tags",
	"POST /api/board/{project}/artifacts/{id}/review",
	"PUT /api/board/{project}/subscribers/{subscriberID}/review-settings",
	"POST /api/board/{project}/tasks/{taskID}/review",
	"POST /api/board/{project}/tasks/{taskID}/attach",
	"POST /api/board/{project}/tasks/{taskID}/mark-landed",
	"POST /api/board/{project}/tasks/{taskID}/reassign",
	"POST /api/board/{project}/health/ack",
	"POST /api/tasks/run",
	"POST /api/sessions/live/{name}/goal",
	"PUT /api/sessions/live/{name}/display-name",
	"PUT /api/sessions/live/{name}/instructions",
	"POST /api/sessions/launch",
	"POST /api/sessions/launch-team",
	"POST /api/sessions/live/{name}/tasks",
	"PATCH /api/sessions/live/{name}/tasks/{taskID}",
	"PATCH /api/agent/tasks/{taskID}",
	"POST /api/agent/tasks",
	"POST /api/agent/tasks/{taskID}/complete",
	"POST /api/agent/tasks/{taskID}/cancel",
	"POST /api/sessions/live/{name}/notes",
	"PATCH /api/sessions/live/{name}/notes/{noteID}",
	"POST /api/sessions/history/{sessionID}/tags",
	"PUT /api/sessions/history/{sessionID}/notes",
	"POST /api/scheduled/jobs",
	"PUT /api/scheduled/jobs/{jobID}",
	"POST /api/artifacts/{id}/comments",
	"PATCH /api/artifacts/{id}/comments/{cid}",
	"POST /api/artifacts/{id}/comments/{cid}/send",
	"POST /api/artifacts/{id}/comments/{cid}/reply",
	"PUT /api/agent/ui/{id}",
	"POST /api/agent/ui-request",
	"PUT /api/themes/{name}",
	"POST /api/themes/import",
	"POST /api/themes/generate",
	"PUT /api/settings",
	"PUT /api/custom-models",
	"POST /api/teams/import",
	"POST /api/teams/generate",
	"PUT /api/teams/detail/{name}/knowledge/{agentName}",
	"POST /api/tags",
	"POST /api/folder-tags/{folderName}",
	"POST /api/workflows",
	"PUT /api/workflows/{workflowID}",
	"POST /api/workflows/by-name/{name}/trigger",
	"POST /api/workflows/{workflowID}/trigger",
	"POST /api/views",
	"PUT /api/views/{id}",
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
			"{subscriberID}", "Lead", "{groupID}", "1", "{name}", "agent-1", "{noteID}", "1", "{sessionID}", "s-1", "{jobID}", "1", "{cid}", "1", "{agentName}", "Lead", "{folderName}", "f", "{workflowID}", "1").Replace(pattern)
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
	"POST /api/board/{project}/operator-artifacts":                     "the body is the Operator's file, stored as bytes; its name is checked in the handler (hasSignInLink) and the file is never rendered (#11376)",
	"POST /api/board/{project}/operator-artifacts/message":             "the body names an agent session and digests this Coral just stored; the message text is made by the server (#11376)",
	"DELETE /api/saved/{id}":                                           "a delete by id: no text is kept",
	"POST /api/board/{project}/clashes":                                "the body is a target in a closed form and two message ids (#11457): the question to the Operator is written by Coral from the stored messages",
	"PUT /api/artifacts/{id}/private":                                  "the body is one true or false (#11457): no text is kept",
	"DELETE /api/board/remotes":                                        "a delete: no text is kept",
	"DELETE /api/board/{project}":                                      "a delete: no text is kept",
	"DELETE /api/board/{project}/subscribe":                            "a delete: no text is kept",
	"DELETE /api/board/{project}/seats/{subscriberID}":                 "a delete by id: no text is kept",
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
	"DELETE /api/agent/ui/{id}":                                        "a delete: no text is kept",
	"DELETE /api/pinned-folders":                                       "a delete: no text is kept",
	"DELETE /api/themes/{name}":                                        "a delete by name: no text is kept",
	"POST /api/pinned-folders":                                         "a folder's path on this computer, not text for others",
	"PUT /api/system/hub-operator":                                     "a switch (disabled: yes or no): no text",
	"DELETE /api/folder-tags/{folderName}/{tagID}":                     "a delete by id: no text is kept",
	"DELETE /api/tags/{tagID}":                                         "a delete by id: no text is kept",
	"DELETE /api/teams/detail/{name}":                                  "a delete: no text is kept",
	"DELETE /api/upload/{name}":                                        "a delete by name: no text is kept",
	"DELETE /api/views/{id}":                                           "a delete by id: no text is kept",
	"DELETE /api/workflows/{workflowID}":                               "a delete by id: no text is kept",
	"POST /api/teams/detail/{name}/distill-knowledge":                  "a control: the server writes the knowledge itself",
	"POST /api/teams/detail/{name}/resurrect":                          "a control: no text is kept",
	"POST /api/upload":                                                 "a file upload: its name is refused in the handler; its contents are the person's (#232 warns of files)",
	"POST /api/workflows/runs/{runID}/kill":                            "ids only",
	"POST /api/workflows/runs/{runID}/seen":                            "ids only",
	"PUT /api/settings/git-diff-mode":                                  "one of a few fixed words",
	"PUT /api/teams/detail/{name}/home-folder":                         "a folder's path on this computer, not text for others",
	"POST /api/board/{project}/external-artifacts":                     "a received file: its metadata (the name) is checked in the handler, as JSON decoded and percent-decoded; its bytes are stored as sent (#232)",
	"DELETE /api/artifacts/series/{series_id}":                         "a delete: no text is kept",
	"DELETE /api/artifacts/{id}":                                       "a delete: no text is kept",
	"DELETE /api/artifacts/{id}/comments/lock":                         "a delete: no text is kept",
	"DELETE /api/artifacts/{id}/comments/{cid}":                        "a delete: no text is kept",
	"DELETE /api/artifacts/{id}/keep":                                  "a delete: no text is kept",
	"DELETE /api/artifacts/{id}/star":                                  "a delete: no text is kept",
	"DELETE /api/scheduled/jobs/{jobID}":                               "a delete: no text is kept",
	"DELETE /api/sessions/history/{sessionID}/tags/{tagID}":            "a delete: no text is kept",
	"DELETE /api/sessions/live/{name}/events":                          "a delete: no text is kept",
	"DELETE /api/sessions/live/{name}/held/{id}":                       "a delete: no text is kept",
	"DELETE /api/sessions/live/{name}/notes/{noteID}":                  "a delete: no text is kept",
	"DELETE /api/sessions/live/{name}/tasks/{taskID}":                  "a delete: no text is kept",
	"PATCH /api/sessions/history/{sessionID}/flags":                    "flags only (pinned, starred): no text",
	"POST /api/agent/artifacts":                                        "a file upload: its name (X-Artifact-Name) is refused in the handler; its contents are warned of on the client, not refused (#232)",
	"POST /api/agent/tasks/claim":                                      "ids only",
	"POST /api/agent/tasks/current":                                    "ids only",
	"POST /api/agent/tasks/{taskID}/publish":                           "ids only",
	"POST /api/agent/ui/{id}/events":                                   "the person's clicks in an agent's panel, sent to the agent: no text kept for others",
	"POST /api/artifacts/prune":                                        "a control: no text is kept",
	"POST /api/artifacts/received/unlisted/delete":                     "a delete: no text is kept",
	"POST /api/artifacts/retention/ack":                                "a control: no text is kept",
	"POST /api/artifacts/{id}/comments/{cid}/reopen":                   "a control: no text is kept",
	"POST /api/artifacts/{id}/comments/{cid}/resolve":                  "a control: no text is kept",
	"POST /api/scheduled/jobs/init-repo":                               "a folder to make a repository in: a path, not text for others",
	"POST /api/scheduled/jobs/{jobID}/run":                             "a control: no text is kept",
	"POST /api/scheduled/jobs/{jobID}/toggle":                          "a control: no text is kept",
	"POST /api/scheduled/runs/{runID}/seen":                            "ids only",
	"POST /api/scheduled/validate-cron":                                "checks a schedule and keeps nothing",
	"POST /api/sessions/history/{sessionID}/resummarize":               "a control: no text is kept",
	"POST /api/sessions/live/sleep-all":                                "a control: no text is kept",
	"POST /api/sessions/live/team/{boardName}/kill":                    "a control: no text is kept",
	"POST /api/sessions/live/team/{boardName}/reset":                   "a control: no text is kept",
	"POST /api/sessions/live/team/{boardName}/sleep":                   "a control: no text is kept",
	"POST /api/sessions/live/team/{boardName}/wake":                    "a control: no text is kept",
	"POST /api/sessions/live/wake-all":                                 "a control: no text is kept",
	"POST /api/sessions/live/{name}/answer-prompt":                     "input typed into an agent's terminal: it goes to the agent, not kept for others to read",
	"POST /api/sessions/live/{name}/dismiss-wait":                      "ids only (session_id, agent_type): no text is kept",
	"POST /api/sessions/live/{name}/attach":                            "a control: no text is kept",
	"POST /api/sessions/live/{name}/auto-accept/disable":               "a control: no text is kept",
	"POST /api/sessions/live/{name}/auto-accept/enable":                "a control: no text is kept",
	"POST /api/sessions/live/{name}/context-window":                    "a control: no text is kept",
	"POST /api/sessions/live/{name}/notices/pause":                     "a control: no text is kept",
	"POST /api/sessions/live/{name}/notices/resume":                    "a control: no text is kept",
	"POST /api/sessions/live/{name}/files/refresh":                     "a control: no text is kept",
	"POST /api/sessions/live/{name}/keys":                              "input typed into an agent's terminal: it goes to the agent, not kept for others to read",
	"POST /api/sessions/live/{name}/kill":                              "a control: no text is kept",
	"POST /api/sessions/live/{name}/model":                             "a model's name and level: no text for others",
	"POST /api/sessions/live/{name}/open-in-editor":                    "a path opened on this computer: no text kept",
	"POST /api/sessions/live/{name}/resize":                            "a control: no text is kept",
	"POST /api/sessions/live/{name}/restart":                           "a control: no text is kept",
	"POST /api/sessions/live/{name}/resume":                            "a control: no text is kept",
	"POST /api/sessions/live/{name}/send":                              "input typed into an agent's terminal: it goes to the agent, not kept for others to read",
	"POST /api/sessions/live/{name}/share-file":                        "a file's contents (code may quote the parameter): files are warned of on the client, not refused (#232)",
	"POST /api/sessions/live/{name}/tasks/reorder":                     "ids only",
	"POST /api/sessions/live/{name}/token-usage":                       "an agent's own hook reporting what its tools did: refusing it would lose the record; it is not posted for others",
	"POST /api/sessions/live/{name}/waiting/send":                      "input typed into an agent's terminal: it goes to the agent, not kept for others to read",
	"POST /api/sessions/live/{sessionID}/archive":                      "a control: no text is kept",
	"POST /api/sessions/live/{sessionID}/refresh-hooks":                "a control: no text is kept",
	"POST /api/sessions/live/{sessionID}/sleep":                        "a control: no text is kept",
	"POST /api/sessions/live/{sessionID}/unarchive":                    "a control: no text is kept",
	"POST /api/sessions/live/{sessionID}/wake":                         "a control: no text is kept",
	"PUT /api/artifacts/{id}/comments/lock":                            "a control: no text is kept",
	"PUT /api/artifacts/{id}/keep":                                     "a control: no text is kept",
	"PUT /api/artifacts/{id}/star":                                     "a control: no text is kept",
	"PUT /api/sessions/live/{name}/file-content":                       "a file's contents (code may quote the parameter): files are warned of on the client, not refused (#232)",
	"PUT /api/sessions/live/{name}/icon":                               "an icon's name: no text for others",
	"PUT /api/sessions/live/{name}/name-color":                         "a colour: no text",
	"POST /api/tasks/runs/{runID}/kill":                                "ids only",
}

// writeRoutesFromOtherRows are write routes another PR of the same batch adds, listed here with why they carry no text, so the tree they
// merge into passes. A route here need not be served on this PR's own tree (the PR that adds it may land first or after); once it is, it
// is treated as any listed route.
var writeRoutesFromOtherRows = map[string]string{
	"POST /api/sessions/live/{sessionID}/record-agent": "#226: a process id, its start time and a yes/no; no text",
	"POST /api/sessions/record-agents":                 "#226: the agents a dry run listed, or ?all=1; the server walks the live sessions",
}

// Every write route under the board, saved-item, notification and one-shot task prefixes either refuses a sign-in link (routes.RefuseSignInLink
// as its middleware) or is listed in writeRoutesWithoutTheGuard with why; the two lists agree with what the router serves.
func TestEveryWriteRouteIsGuardedOrSaysWhyNot(t *testing.T) {
	srv, _, _ := strictServer(t, false)
	guard := reflect.ValueOf(routes.RefuseSignInLink).Pointer()
	redact := reflect.ValueOf(routes.RedactSignInLink).Pointer() // an agent's own hook reports: the link's value is replaced, the record kept
	served := map[string]bool{}
	require.NoError(t, chi.Walk(srv.Router(), func(method, route string, _ http.Handler, mws ...func(http.Handler) http.Handler) error {
		switch method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		default:
			return nil
		}
		if !guardCensusCovers(route) {
			return nil
		}
		key := method + " " + route
		served[key] = true
		guarded := false
		for _, mw := range mws {
			if pc := reflect.ValueOf(mw).Pointer(); pc == guard || pc == redact {
				guarded = true
			}
		}
		why, listed := writeRoutesWithoutTheGuard[key]
		if !listed {
			why, listed = writeRoutesFromOtherRows[key]
		}
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

// guardCensusCovers is which routes TestEveryWriteRouteIsGuardedOrSaysWhyNot looks at.
func guardCensusCovers(route string) bool {
	for _, p := range []string{"/api/board/", "/api/saved", "/api/tasks/", "/api/artifacts", "/api/agent/", "/api/sessions/", "/api/scheduled/",
		"/api/teams/", "/api/workflows", "/api/settings", "/api/tags", "/api/folder-tags", "/api/views", "/api/custom-models", "/api/upload",
		"/api/themes", "/api/pinned-folders", "/api/system/hub-operator"} {
		if strings.HasPrefix(route, p) {
			return true
		}
	}
	return route == "/api/notifications"
}
