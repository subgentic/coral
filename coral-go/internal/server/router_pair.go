package server

import "github.com/subgentic/coral/internal/server/routes"

// pairRecordedRoutes are the tunnel-reachable write routes (method + route pattern) that routes.RecordPairWrites records with the (link, Hub person) pair (#20369, multi-Hub). A route is added here in
// the same commit as its proof in pair_census_test.go (pairProven), and its golden line turns from pending to recorded. Batch 1: device keys, the cloud link, the system update, and the settings
// toggles.
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
}
