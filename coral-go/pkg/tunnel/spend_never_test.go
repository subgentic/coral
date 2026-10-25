package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7525: the Analytics spend read (tokens, commits, tool calls and task times of a team, naming its agents) is never reachable through Coral Hub for now: it has no row in the table.
func TestTheSpendReadIsNeverThroughTheHub(t *testing.T) {
	for _, path := range []string{"/api/board/b-abcdefghij/spend", "/api/board/my-team/spend"} {
		assert.Equal(t, TierNever, Classify(http.MethodGet, path, "range=24h"), path)
		for _, m := range []Mode{TierView, TierInteract, TierLaunch} {
			assert.False(t, AllowRequest(func() Mode { return m })(http.MethodGet, path, "range=24h"), "%s at %v", path, m)
		}
	}
}
