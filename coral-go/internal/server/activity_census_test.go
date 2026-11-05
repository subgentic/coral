package server

import (
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/server/routes"
)

// #13609: the Operator's Activity record cannot drift from what the Inbox lets a person do. Every route that writes (POST, PUT, PATCH, DELETE) is in exactly one list below, each with its reason. A route
// added later is in none, and TestEveryMutatingRouteIsInTheActivityCensus fails until its author decides: it writes a row (activityRoutes in routes/activity_routes.go, or the handler's own row, listed in
// activityByHandler), or it is not an Inbox action and the list says why. Document and video comments are excluded by name (the Operator's call). activityGaps is the work left of #13609: it
// only shrinks, and the test fails a route that is listed there and recorded too.

// activityByHandler: the handler writes the row itself (in the store transaction of the decision, or after the post), for a person only.
var activityByHandler = map[string]string{
	"DELETE /api/board/{project}/artifacts/{id}/review":                   "take out of review (unsend_review)",
	"POST /api/board/{project}/artifacts/{id}/review":                     "a file's review: approve, changes, deny, ignore, unignore, save, unsave, supersede (board.DecideArtifactReview and friends)",
	"POST /api/board/{project}/asks/{messageID}/buttons/{buttonID}/claim": "an ask button's click (answer)",
	"POST /api/board/{project}/asks/{messageID}/close":                    "a question's Ignore and Put back (ignore, unignore)",
	"POST /api/board/{project}/goals/{goalID}/close":                      "close a goal (goal_close)",
	"POST /api/board/{project}/messages":                                  "a message or a typed answer by the Operator: PostMessage writes message or answer",
	"POST /api/board/{project}/proposals/{id}/approve":                    "a proposal's approve",
	"POST /api/board/{project}/proposals/{id}/reject":                     "a proposal's reject",
	"POST /api/board/{project}/tasks/{taskID}/reply":                      "the Operator's words on a task: ReplyToTask writes task_reply",
	"POST /api/system/update/check-hub":                                   "the Hub owner's update check (hub_update_check)",
	"POST /api/system/update/relaunch":                                    "the Hub owner's relaunch (hub_update_relaunch)",
	"PUT /api/board/{project}/artifacts/{id}/review":                      "send for review (send_review)",
}

// activityGaps: Inbox or chat actions that write no row yet (#13609, slice 2). Each one leaves this list when its row is written and tested.
var activityGaps = map[string]string{
	"DELETE /api/artifacts/series/{series_id}":                    "delete a file's series (slice 2)",
	"DELETE /api/artifacts/{id}":                                  "delete a file (slice 2)",
	"DELETE /api/artifacts/{id}/keep":                             "release a file (slice 2)",
	"DELETE /api/artifacts/{id}/star":                             "unstar a file (slice 2)",
	"DELETE /api/saved/{id}":                                      "remove a saved message (slice 2)",
	"PATCH /api/board/{project}/goals/{goalID}":                   "reopen or edit a goal (slice 2)",
	"PATCH /api/saved/{id}":                                       "Done or Reopen on a saved message (slice 2)",
	"PATCH /api/sessions/history/{sessionID}/flags":               "star or archive a chat (slice 2)",
	"POST /api/board/{project}/goal-images":                       "a picture for a goal (slice 2)",
	"POST /api/board/{project}/goal-requests/{requestID}/accept":  "accept a goal request (slice 2)",
	"POST /api/board/{project}/goal-requests/{requestID}/decline": "decline a goal request (slice 2)",
	"POST /api/board/{project}/goals":                             "new goal (slice 2)",
	"POST /api/board/{project}/goals/{goalID}/driver":             "change a goal's driver (slice 2)",
	"POST /api/board/{project}/goals/{goalID}/move":               "move a goal to another team (slice 2)",
	"POST /api/board/{project}/messages/mark-read":                "Mark read in the team's own views (slice 2: only the explicit buttons)",
	"POST /api/board/{project}/operator-artifacts":                "share a file with an agent (slice 2)",
	"POST /api/board/{project}/operator-artifacts/message":        "the message that tells the agent about a shared file (slice 2)",
	"POST /api/saved":                                             "bookmark a message (slice 2)",
	"POST /api/scheduled/runs/{runID}/seen":                       "a failed run's Open and Dismiss (slice 2)",
	"POST /api/sessions/live/{name}/send":                         "the chat composer's Send to an agent (slice 2)",
	"POST /api/sessions/record-agents":                            "Record for all agents (slice 2)",
	"POST /api/workflows/runs/{runID}/seen":                       "a failed run's Open and Dismiss (slice 2)",
	"PUT /api/artifacts/{id}/keep":                                "keep a file (slice 2)",
	"PUT /api/artifacts/{id}/star":                                "star a file (slice 2)",
	"PUT /api/board/{project}/artifacts/{id}/tags":                "mark read, mark unread and tag edits on a file (slice 2)",
	"PUT /api/settings":                                           "Inbox hides kept in settings: goal-done Dismiss and Not yet, welcome Dismiss (slice 2)",
}

// activityCommentsOut: comments, out of the audit by the Operator\'s call.
var activityCommentsOut = map[string]string{
	"DELETE /api/artifacts/{id}/comments/lock":        "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"DELETE /api/artifacts/{id}/comments/{cid}":       "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"PATCH /api/artifacts/{id}/comments/{cid}":        "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"POST /api/artifacts/{id}/comment-images":         "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"POST /api/artifacts/{id}/comments":               "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"POST /api/artifacts/{id}/comments/{cid}/reopen":  "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"POST /api/artifacts/{id}/comments/{cid}/reply":   "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"POST /api/artifacts/{id}/comments/{cid}/resolve": "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"POST /api/artifacts/{id}/comments/{cid}/send":    "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
	"PUT /api/artifacts/{id}/comments/lock":           "document and video comments are out of the audit (the Operator's call, 2026-11-05)",
}

// activityNotAnInboxAction: a route a person (or an agent) can reach that is not an action in the Inbox, with why.
var activityNotAnInboxAction = map[string]string{
	"DELETE /api/agent/ui/{id}":                                            "an agent's own call: no person's click",
	"DELETE /api/auth/sessions/{id}":                                       "sign-in and sessions",
	"DELETE /api/board/remotes":                                            "computers on the board",
	"DELETE /api/board/{project}":                                          "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/board/{project}/cross-team-links":                         "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/board/{project}/groups/{groupID}/members/{sessionID}":     "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/board/{project}/messages/{messageID}":                     "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/board/{project}/reminder":                                 "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/board/{project}/seats/{subscriberID}":                     "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/board/{project}/subscribe":                                "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/board/{project}/waits":                                    "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"DELETE /api/chief/checks/{checkID}":                                   "the Chief page",
	"DELETE /api/folder-tags/{folderName}/{tagID}":                         "tags on folders",
	"DELETE /api/pinned-folders":                                           "pinned folders",
	"DELETE /api/scheduled/jobs/{jobID}":                                   "the Automations tab",
	"DELETE /api/sessions/history/{sessionID}/tags/{tagID}":                "a chat's own page",
	"DELETE /api/sessions/live/{name}/events":                              "an agent's own page: its controls, notes and tasks, not the Inbox",
	"DELETE /api/sessions/live/{name}/held/{id}":                           "an agent's own page: its controls, notes and tasks, not the Inbox",
	"DELETE /api/sessions/live/{name}/notes/{noteID}":                      "an agent's own page: its controls, notes and tasks, not the Inbox",
	"DELETE /api/sessions/live/{name}/tasks/{taskID}":                      "an agent's own page: its controls, notes and tasks, not the Inbox",
	"DELETE /api/shared-images/{id}":                                       "images shared in a chat",
	"DELETE /api/skills/{id}":                                              "the Skills tab",
	"DELETE /api/system/debug-input-log":                                   "this computer's settings and controls, not an Inbox action",
	"DELETE /api/tags/{tagID}":                                             "tags on chats",
	"DELETE /api/teams/detail/{name}":                                      "the Teams pages",
	"DELETE /api/themes/{name}":                                            "themes",
	"DELETE /api/upload/{name}":                                            "file upload to a chat",
	"DELETE /api/views/{id}":                                               "saved views",
	"DELETE /api/workflows/{workflowID}":                                   "the Automations tab",
	"PATCH /api/agent/tasks/{taskID}":                                      "an agent's own call: no person's click",
	"PATCH /api/board/{project}":                                           "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"PATCH /api/sessions/live/{name}/notes/{noteID}":                       "an agent's own page: its controls, notes and tasks, not the Inbox",
	"PATCH /api/sessions/live/{name}/tasks/{taskID}":                       "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/agent/artifacts":                                            "an agent's own call: no person's click",
	"POST /api/agent/skills":                                               "an agent's own call: no person's click",
	"POST /api/agent/tasks":                                                "an agent's own call: no person's click",
	"POST /api/agent/tasks/claim":                                          "an agent's own call: no person's click",
	"POST /api/agent/tasks/current":                                        "an agent's own call: no person's click",
	"POST /api/agent/tasks/{taskID}/cancel":                                "an agent's own call: no person's click",
	"POST /api/agent/tasks/{taskID}/complete":                              "an agent's own call: no person's click",
	"POST /api/agent/tasks/{taskID}/publish":                               "an agent's own call: no person's click",
	"POST /api/agent/ui-request":                                           "an agent's own call: no person's click",
	"POST /api/agent/ui/{id}/events":                                       "an agent's own call: no person's click",
	"POST /api/agents/models/refresh":                                      "model lists",
	"POST /api/artifacts/prune":                                            "file retention",
	"POST /api/artifacts/received/unlisted/delete":                         "received files",
	"POST /api/artifacts/retention/ack":                                    "file retention",
	"POST /api/auth/hub-signin/dismiss":                                    "sign-in and sessions",
	"POST /api/auth/password/change":                                       "sign-in and sessions",
	"POST /api/auth/password/reset":                                        "sign-in and sessions",
	"POST /api/auth/password/set":                                          "sign-in and sessions",
	"POST /api/auth/sessions/sign-out-others":                              "sign-in and sessions",
	"POST /api/auto-accept/disable-all":                                    "settings",
	"POST /api/board/remotes":                                              "computers on the board",
	"POST /api/board/{project}/agents/{subscriber}/sleep":                  "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/agents/{subscriber}/wake":                   "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/asks/{messageID}/buttons/{buttonID}/settle": "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/clashes":                                    "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/cross-team-links":                           "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/cross-team/disable":                         "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/cross-team/enable":                          "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/cross-team/files/disable":                   "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/cross-team/files/enable":                    "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/external-artifacts":                         "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/external-messages":                          "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/goal-requests":                              "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/groups/{groupID}/members":                   "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/health/ack":                                 "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/hub-notice":                                 "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/pause":                                      "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/relay-messages":                             "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/reminder":                                   "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/resume":                                     "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/subscribe":                                  "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/tasks/claim":                                "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/tasks/current":                              "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/tasks/{taskID}/attach":                      "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/tasks/{taskID}/mark-landed":                 "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/tasks/{taskID}/release-review":              "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/tasks/{taskID}/review":                      "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/tasks/{taskID}/submit-review":               "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/waits":                                      "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/working-mode/presets":                       "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/board/{project}/working-mode/presets/{presetID}/reset":      "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"POST /api/call-metrics":                                               "telemetry",
	"POST /api/chief/checks":                                               "the Chief page",
	"POST /api/chief/checks/{checkID}/run":                                 "the Chief page",
	"POST /api/chief/triggers/{triggerID}/state":                           "the Chief page",
	"POST /api/cloud/cli-hello":                                            "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/connect":                                              "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/connect/cancel":                                       "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/cross-team-links":                                     "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/disconnect":                                           "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/guide-revoked":                                        "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/owner-label/arm":                                      "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/redeem":                                               "Coral Hub connection and Hub-to-computer calls",
	"POST /api/cloud/rekey":                                                "Coral Hub connection and Hub-to-computer calls",
	"POST /api/folder-tags/{folderName}":                                   "tags on folders",
	"POST /api/history-import":                                             "importing earlier chats",
	"POST /api/hub-auto-accept":                                            "settings",
	"POST /api/indexer/refresh":                                            "search index",
	"POST /api/notifications":                                              "notification settings",
	"POST /api/pinned-folders":                                             "pinned folders",
	"POST /api/scheduled/jobs":                                             "the Automations tab",
	"POST /api/scheduled/jobs/init-repo":                                   "the Automations tab",
	"POST /api/scheduled/jobs/{jobID}/run":                                 "the Automations tab",
	"POST /api/scheduled/jobs/{jobID}/toggle":                              "the Automations tab",
	"POST /api/scheduled/validate-cron":                                    "the Automations tab",
	"POST /api/sessions/history/{sessionID}/resummarize":                   "a chat's own page",
	"POST /api/sessions/history/{sessionID}/tags":                          "a chat's own page",
	"POST /api/sessions/launch":                                            "launching agents",
	"POST /api/sessions/launch-team":                                       "launching agents",
	"POST /api/sessions/live/sleep-all":                                    "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/sleep-gone":                                   "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/team/{boardName}/kill":                        "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/team/{boardName}/reset":                       "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/team/{boardName}/sleep":                       "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/team/{boardName}/wake":                        "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/wake-all":                                     "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/attach":                                "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/auto-accept/disable":                   "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/auto-accept/enable":                    "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/auto-sleep":                            "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/context-window":                        "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/events":                                "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/files/refresh":                         "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/goal":                                  "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/keys":                                  "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/kill":                                  "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/model":                                 "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/notes":                                 "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/notices/pause":                         "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/notices/resume":                        "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/open-in-editor":                        "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/pending-tool":                          "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/resize":                                "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/restart":                               "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/resume":                                "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/share-file":                            "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/skills":                                "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/tasks":                                 "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/tasks/reorder":                         "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/token-usage":                           "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{name}/turn-end":                              "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{sessionID}/archive":                          "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{sessionID}/record-agent":                     "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{sessionID}/refresh-hooks":                    "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{sessionID}/sleep":                            "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{sessionID}/unarchive":                        "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/sessions/live/{sessionID}/wake":                             "an agent's own page: its controls, notes and tasks, not the Inbox",
	"POST /api/skills":                                                     "the Skills tab",
	"POST /api/skills/{id}/approve":                                        "the Skills tab",
	"POST /api/skills/{id}/reject":                                         "the Skills tab",
	"POST /api/system/api-key/regenerate":                                  "this computer's settings and controls, not an Inbox action",
	"POST /api/system/auto-wake/dismiss":                                   "this computer's settings and controls, not an Inbox action",
	"POST /api/system/data-folder/adopt":                                   "this computer's settings and controls, not an Inbox action",
	"POST /api/system/login-token":                                         "this computer's settings and controls, not an Inbox action",
	"POST /api/system/restart":                                             "this computer's settings and controls, not an Inbox action",
	"POST /api/system/telemetry/acknowledge":                               "this computer's settings and controls, not an Inbox action",
	"POST /api/system/terminal-backend/end-leftover":                       "this computer's settings and controls, not an Inbox action",
	"POST /api/system/terminal-backend/notice-seen":                        "this computer's settings and controls, not an Inbox action",
	"POST /api/system/terminal-logs/delete-ended":                          "this computer's settings and controls, not an Inbox action",
	"POST /api/system/update/check":                                        "this computer's settings and controls, not an Inbox action",
	"POST /api/system/update/install":                                      "this computer's settings and controls, not an Inbox action",
	"POST /api/system/update/relaunch-local":                               "this computer's settings and controls, not an Inbox action",
	"POST /api/tags":                                                       "tags on chats",
	"POST /api/tasks/run":                                                  "scheduled task runs",
	"POST /api/tasks/runs/{runID}/kill":                                    "scheduled task runs",
	"POST /api/teams/detail/{name}/distill-knowledge":                      "the Teams pages",
	"POST /api/teams/detail/{name}/resurrect":                              "the Teams pages",
	"POST /api/teams/generate":                                             "the Teams pages",
	"POST /api/teams/import":                                               "the Teams pages",
	"POST /api/themes/generate":                                            "themes",
	"POST /api/themes/import":                                              "themes",
	"POST /api/tracking/event":                                             "telemetry",
	"POST /api/upload":                                                     "file upload to a chat",
	"POST /api/views":                                                      "saved views",
	"POST /api/workflows":                                                  "the Automations tab",
	"POST /api/workflows/by-name/{name}/trigger":                           "the Automations tab",
	"POST /api/workflows/runs/{runID}/kill":                                "the Automations tab",
	"POST /api/workflows/{workflowID}/trigger":                             "the Automations tab",
	"POST /api/worktrees/remove":                                           "git worktrees",
	"POST /auth/hub/link":                                                  "sign-in and sessions",
	"POST /auth/hub/start":                                                 "sign-in and sessions",
	"POST /auth/key":                                                       "sign-in and sessions",
	"POST /auth/local":                                                     "sign-in and sessions",
	"POST /auth/logout":                                                    "sign-in and sessions",
	"POST /auth/password":                                                  "sign-in and sessions",
	"POST /auth/password/create":                                           "sign-in and sessions",
	"PUT /api/agent/ui/{id}":                                               "an agent's own call: no person's click",
	"PUT /api/artifacts/{id}/private":                                      "a file's privacy",
	"PUT /api/auth/hub-origins":                                            "sign-in and sessions",
	"PUT /api/auth/hub-signin":                                             "sign-in and sessions",
	"PUT /api/board/{project}/guide-roster":                                "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"PUT /api/board/{project}/orchestrator-grant":                          "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"PUT /api/board/{project}/settings":                                    "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"PUT /api/board/{project}/subscribers/{subscriberID}/review-settings":  "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"PUT /api/board/{project}/working-mode":                                "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"PUT /api/board/{project}/working-mode/presets/{presetID}":             "a team's own settings and plumbing (members, modes, links, relays), not an Inbox action",
	"PUT /api/chief/checks/{checkID}":                                      "the Chief page",
	"PUT /api/cloud/allow-auto-accept":                                     "Coral Hub connection and Hub-to-computer calls",
	"PUT /api/cloud/hub-cross-team":                                        "Coral Hub connection and Hub-to-computer calls",
	"PUT /api/cloud/hub-relaunch":                                          "Coral Hub connection and Hub-to-computer calls",
	"PUT /api/cloud/max-mode":                                              "Coral Hub connection and Hub-to-computer calls",
	"PUT /api/cloud/redact-tokens":                                         "Coral Hub connection and Hub-to-computer calls",
	"PUT /api/custom-models":                                               "settings",
	"PUT /api/scheduled/jobs/{jobID}":                                      "the Automations tab",
	"PUT /api/sessions/history/{sessionID}/notes":                          "a chat's own page",
	"PUT /api/sessions/live/{name}/display-name":                           "an agent's own page: its controls, notes and tasks, not the Inbox",
	"PUT /api/sessions/live/{name}/file-content":                           "an agent's own page: its controls, notes and tasks, not the Inbox",
	"PUT /api/sessions/live/{name}/icon":                                   "an agent's own page: its controls, notes and tasks, not the Inbox",
	"PUT /api/sessions/live/{name}/instructions":                           "an agent's own page: its controls, notes and tasks, not the Inbox",
	"PUT /api/sessions/live/{name}/name-color":                             "an agent's own page: its controls, notes and tasks, not the Inbox",
	"PUT /api/settings/git-diff-mode":                                      "this computer's settings",
	"PUT /api/system/codex-trust-hooks":                                    "this computer's settings and controls, not an Inbox action",
	"PUT /api/system/database-security":                                    "this computer's settings and controls, not an Inbox action",
	"PUT /api/system/hub-mode":                                             "this computer's settings and controls, not an Inbox action",
	"PUT /api/system/hub-operator":                                         "this computer's settings and controls, not an Inbox action",
	"PUT /api/system/identity-actor":                                       "this computer's settings and controls, not an Inbox action",
	"PUT /api/system/terminal-backend":                                     "this computer's settings and controls, not an Inbox action",
	"PUT /api/system/update/settings":                                      "this computer's settings and controls, not an Inbox action",
	"PUT /api/team-members/{memberID}/search-access":                       "the Teams pages",
	"PUT /api/teams/detail/{name}/home-folder":                             "the Teams pages",
	"PUT /api/teams/detail/{name}/knowledge/{agentName}":                   "the Teams pages",
	"PUT /api/themes/{name}":                                               "themes",
	"PUT /api/views/{id}":                                                  "saved views",
	"PUT /api/workflows/{workflowID}":                                      "the Automations tab",
}

func TestEveryMutatingRouteIsInTheActivityCensus(t *testing.T) {
	srv, _, _ := strictServer(t, false)
	recorded := routes.ActivityRoutes()
	served := map[string]bool{}
	require.NoError(t, chi.Walk(srv.Router(), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		switch method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			if !strings.HasPrefix(route, "/static/") {
				served[method+" "+route] = true
			}
		}
		return nil
	}))
	var unlisted []string
	for rt := range served {
		n := 0
		for _, set := range []func(string) bool{
			func(k string) bool { _, ok := recorded[k]; return ok },
			func(k string) bool { _, ok := activityByHandler[k]; return ok },
			func(k string) bool { _, ok := activityGaps[k]; return ok },
			func(k string) bool { _, ok := activityCommentsOut[k]; return ok },
			func(k string) bool { _, ok := activityNotAnInboxAction[k]; return ok },
		} {
			if set(rt) {
				n++
			}
		}
		switch {
		case n == 0:
			unlisted = append(unlisted, rt)
		case n > 1:
			t.Errorf("%s is in more than one census list", rt)
		}
	}
	sort.Strings(unlisted)
	assert.Empty(t, unlisted, "a route that writes has no Activity row and no reason: record the action (routes/activity_routes.go) or say in activity_census_test.go why it is not an Inbox action")
	for _, m := range []map[string]string{activityByHandler, activityGaps, activityCommentsOut, activityNotAnInboxAction} {
		for rt := range m {
			assert.True(t, served[rt], "%s is listed in the census but is not a route", rt)
		}
	}
	for rt := range recorded {
		assert.True(t, served[rt], "%s is recorded by the table but is not a route", rt)
	}
}
