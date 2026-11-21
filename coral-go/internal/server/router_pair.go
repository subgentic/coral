package server

import "github.com/subgentic/coral/internal/server/routes"

// pairRecordedRoutes are the tunnel-reachable write routes (method + route pattern) that routes.RecordPairWrites records with the (link, Hub person) pair (#20369, multi-Hub). A route is added here in
// the same commit as its proof in pair_census_test.go (pairProven), and its golden line turns from pending to recorded. Batch 1: device keys, the cloud link, the system update and the settings toggles; batch 2: artifacts, Dropbox, upload, saved, pinned folders.
var pairRecordedRoutes = routes.PairRecorded{
	"POST /api/device-keys/certificate": true,
	"POST /api/device-keys/message":     true,
	"POST /api/cloud/cross-team-links":  true,
	"POST /api/system/update/check-hub": true,
	"POST /api/system/update/relaunch":  true,
	"PUT /api/settings/git-diff-mode":   true,
	"POST /api/auto-accept/disable-all": true,
	"POST /api/hub-auto-accept":         true,
	"PUT /api/custom-models":            true,
	"PUT /api/custom-modes":             true,

	// Batch 2 (#20369): artifacts, Dropbox, the upload, saved messages and pinned folders.
	"DELETE /api/artifacts/{id}":                      true,
	"DELETE /api/artifacts/{id}/comments/lock":        true,
	"DELETE /api/artifacts/{id}/comments/{cid}":       true,
	"DELETE /api/artifacts/{id}/star":                 true,
	"DELETE /api/artifacts/{id}/trust-preview":        true,
	"DELETE /api/pinned-folders":                      true,
	"DELETE /api/saved/{id}":                          true,
	"PATCH /api/artifacts/{id}/comments/{cid}":        true,
	"PATCH /api/saved/{id}":                           true,
	"POST /api/artifacts/{id}/comment-images":         true,
	"POST /api/artifacts/{id}/comments":               true,
	"POST /api/artifacts/{id}/comments/{cid}/reopen":  true,
	"POST /api/artifacts/{id}/comments/{cid}/resolve": true,
	"POST /api/artifacts/{id}/comments/{cid}/send":    true,
	"POST /api/artifacts/{id}/opened":                 true,
	"POST /api/dropbox/prepare":                       true,
	"POST /api/dropbox/push":                          true,
	"POST /api/dropbox/shared":                        true,
	"POST /api/pinned-folders":                        true,
	"POST /api/saved":                                 true,
	"POST /api/upload":                                true,
	"PUT /api/artifacts/{id}/comments/lock":           true,
	"PUT /api/artifacts/{id}/private":                 true,
	"PUT /api/artifacts/{id}/star":                    true,
	"PUT /api/artifacts/{id}/trust-preview":           true,
}
