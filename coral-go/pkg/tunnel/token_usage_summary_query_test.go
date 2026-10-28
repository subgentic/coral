package tunnel

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #9820 (coral-hub): the token-usage summary takes include=totals (no per-session list) and by_agent_limit=N, besides since. include passes only as exactly "totals", once; anything else is
// refused here, as the handler refuses it, and an unknown parameter still is.
func TestTokenUsageSummaryQueryKeys(t *testing.T) {
	const route = "/api/token-usage/summary"
	for _, q := range []string{"", "since=2026-10-01T00:00:00Z", "include=totals", "by_agent_limit=50", "include=totals&since=2026-10-01T00:00:00Z", "by_agent_limit=50&since=2026-10-01T00:00:00Z"} {
		assert.Equal(t, TierView, Classify("GET", route, q), q)
	}
	for _, q := range []string{"include=", "include=all", "include=Totals", "include=totals&include=totals", "include=totals,by_agent", "by_agent=1", "limit=5", "byagentlimit=5"} {
		assert.Equal(t, TierNever, Classify("GET", route, q), q)
	}
}
