package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20882: a relayed hub-auto-accept request signs ?allow=true or ?allow=false. The table lets exactly that query through on that route, once, and nothing else; the tier is the same Launch as with no query.
func TestHubAutoAcceptAcceptsExactlyTheSignedQuery(t *testing.T) {
	const p = "/api/hub-auto-accept"
	for _, q := range []string{"", "allow=true", "allow=false"} {
		assert.Equal(t, TierLaunch, Classify(http.MethodPost, p, q), "query %q", q)
	}
	for _, q := range []string{
		"allow=True", "allow=TRUE", "allow=true ", "allow=%74rue", "allow=", "allow", "allow=1", "allow=yes",
		"allow=true&x=1", "allow=true&allow=false", "allow=true&allow=true", "x=1", "Allow=true", "allow=true;x=1", "allow[]=true",
	} {
		assert.Equal(t, TierNever, Classify(http.MethodPost, p, q), "query %q", q)
	}
	// Only the POST route takes it; another method or route does not gain the query.
	assert.Equal(t, TierNever, Classify(http.MethodGet, p, "allow=true"))
	assert.Equal(t, TierNever, Classify(http.MethodPost, "/api/sessions/live/x/auto-accept/enable", "allow=true"))
}
