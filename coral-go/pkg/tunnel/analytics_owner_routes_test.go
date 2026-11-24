package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The rest of the Analytics page through Coral Hub (coral-hub #261001): Inbox vs chat, the resource queue, tokens per commit and task time (efficiency) and Tasks completed are launch-tier reads and the
// OWNER's alone, like the activity counts, each with a closed list of the keys its handler reads.
func TestTheAnalyticsReadsAreLaunchTierOwnerRowsWithAClosedQuery(t *testing.T) {
	for _, c := range []struct{ path, query string }{
		{"/api/analytics/inbox-vs-chat", "days=14&team=x1"},
		{"/api/analytics/resource-queue", "days=14"},
		{"/api/analytics/efficiency", "metric=tokens_per_commit&group_by=agent&range=7d&team=x1"},
		{"/api/analytics/tasks", "range=7d&group_by=agent&reviews=1&team=x1"},
		{"/api/analytics/activity", "team=x1&range=14d"},
	} {
		assert.Equal(t, TierLaunch, Classify(http.MethodGet, c.path, c.query), c.path)
		pattern, mode := OwnerRoute(http.MethodGet, c.path)
		assert.Equal(t, c.path, pattern, c.path+": its own row")
		assert.Equal(t, OwnerRefuse, mode, c.path+": the machine refuses anyone but the owner before the handler runs")
		assert.Equal(t, TierNever, ClassifyService(http.MethodGet, c.path, c.query), c.path+": not the Hub service's")
		assert.Equal(t, TierNever, Classify(http.MethodGet, c.path, "zz_unknown=1"), c.path+": a key the handler does not read is refused")
		assert.Equal(t, TierNever, Classify(http.MethodGet, c.path, c.query+"&zz_unknown=1"), c.path+": one key more is refused")
		assert.Equal(t, TierNever, Classify(http.MethodGet, c.path+"/x1", c.query), c.path+": a longer path is not this row")
		for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			assert.Equal(t, TierNever, Classify(m, c.path, c.query), c.path+": only GET: "+m)
			_, mode := OwnerRoute(m, c.path)
			assert.Equal(t, OwnerNone, mode, c.path+": a write is not made the owner's by this row: "+m)
		}
	}
}
