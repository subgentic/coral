package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #16140 (Security on #16030): through Coral Hub only the queue's list is reachable, and only as the computer owner's. Every other resource route stays "never", at every tier.
func TestOnlyTheResourceListIsReachableThroughTheHubAndItIsTheOwnersAlone(t *testing.T) {
	assert.Equal(t, TierView, Classify(http.MethodGet, "/api/resources", ""), "the list is a View-tier read")
	pattern, mode := OwnerRoute(http.MethodGet, "/api/resources")
	assert.Equal(t, "/api/resources", pattern)
	assert.Equal(t, OwnerRefuse, mode, "the machine refuses anyone but the owner before it reads the queue")
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/resources/mac-heavy"},
		{http.MethodPost, "/api/resources/mac-heavy/claim"},
		{http.MethodPost, "/api/resources/mac-heavy/release"},
		{http.MethodPost, "/api/resources/mac-heavy/renew"},
		{http.MethodPut, "/api/resources/mac-heavy"},
		{http.MethodDelete, "/api/resources/mac-heavy"},
		{http.MethodPost, "/api/resources/entries/7/move"},
		{http.MethodDelete, "/api/resources/entries/7"},
		{http.MethodPost, "/api/resources"},
		{http.MethodPut, "/api/resources"},
		{http.MethodDelete, "/api/resources"},
		{http.MethodGet, "/api/resources/"},
		{http.MethodGet, "/api/resources/entries/7"},
	} {
		assert.Equal(t, TierNever, Classify(c.method, c.path, ""), "%s %s", c.method, c.path)
		_, m := OwnerRoute(c.method, c.path)
		assert.Equal(t, OwnerNone, m, "%s %s is not an owner route (it is not a route at all)", c.method, c.path)
	}
}
