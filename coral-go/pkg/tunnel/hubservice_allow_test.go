package tunnel

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #9084: AllowServiceRequest is the service table's check, at the effective mode; a user route is not a service route and a service route is not a user's.
func TestAllowServiceRequestIsTheServiceTablesCheck(t *testing.T) {
	view := func() Mode { return TierView }
	svc := AllowServiceRequest(view)
	user := AllowRequest(view)
	assert.True(t, svc("GET", "/api/goal-links", "request_id=abc"))
	assert.False(t, user("GET", "/api/goal-links", "request_id=abc"), "the user table refuses the service route")
	assert.False(t, svc("GET", "/api/goal-links", "request_id=abc&q=x"), "a key the route's table does not list")
	assert.False(t, svc("POST", "/api/goal-links", "request_id=abc"), "a write")
	assert.False(t, svc("GET", "/api/agents", ""), "a user route is not a service route")
	assert.False(t, svc("GET", "/api/settings", ""))
	assert.True(t, AllowServiceRequest(nil)("GET", "/api/goal-links", "request_id=abc"), "a nil mode is view")
}
