package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The Automations reads through Coral Hub are the owner's alone (#19570, coral-hub's design §7.3.5): each keeps its old tier and now carries the owner marker, so the machine refuses anyone else (403 owner_only) before
// a handler runs. The owner is sent only the accepted fields (routes.HubFields). Writes are unchanged.
func TestTheAutomationsReadsAreOwnerRefuseAtTheirOldTier(t *testing.T) {
	reads := []struct {
		path string
		tier Mode
	}{
		{"/api/scheduled/jobs", TierView},
		{"/api/scheduled/jobs/7", TierView},
		{"/api/scheduled/jobs/7/runs", TierView},
		{"/api/scheduled/runs/recent", TierView},
		{"/api/automations/runs", TierView},
		{"/api/workflows", TierInteract},
		{"/api/workflows/runs/recent", TierInteract},
		{"/api/workflows/by-name/nightly", TierInteract},
		{"/api/workflows/3", TierInteract},
		{"/api/workflows/3/runs", TierInteract},
		{"/api/workflows/runs/9", TierInteract},
	}
	for _, c := range reads {
		assert.Equal(t, c.tier, Classify(http.MethodGet, c.path, ""), "the tier is unchanged: "+c.path)
		_, mode := OwnerRoute(http.MethodGet, c.path)
		assert.Equal(t, OwnerRefuse, mode, "owner only: "+c.path)
		assert.True(t, IsOwnerRoute(http.MethodGet, c.path), c.path)
	}
	// the writes keep their classes and are not owner routes (a run opened, .../seen, is an OwnerSees route since #21435: stamped so the Activity row names the owner; its class is unchanged)
	for _, p := range []string{"/api/workflows/runs/9/seen", "/api/scheduled/runs/9/seen"} {
		assert.Equal(t, TierInteract, Classify(http.MethodPost, p, ""), p)
		_, mode := OwnerRoute(http.MethodPost, p)
		assert.Equal(t, OwnerSees, mode, p)
	}
	for _, w := range []struct {
		method, path string
		tier         Mode
	}{
		{http.MethodPost, "/api/workflows/3/trigger", TierLaunch},
		{http.MethodPost, "/api/workflows/runs/9/kill", TierInteract},
		{http.MethodPost, "/api/scheduled/jobs", TierNever},
		{http.MethodPut, "/api/scheduled/jobs/7", TierNever},
		{http.MethodDelete, "/api/scheduled/jobs/7", TierNever},
	} {
		assert.Equal(t, w.tier, Classify(w.method, w.path, ""), "a write is unchanged: "+w.method+" "+w.path)
		assert.False(t, IsOwnerRoute(w.method, w.path), "a write is not an owner read: "+w.method+" "+w.path)
	}
}
