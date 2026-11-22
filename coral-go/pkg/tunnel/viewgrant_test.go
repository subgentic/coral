package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The View list is a census: each entry is a GET at the View tier with a board in its path, and the list is exactly this one. Adding a route is a decision made in this test.
func TestTheViewGrantListIsClosedAndEachRouteNamesABoard(t *testing.T) {
	assert.Equal(t, []string{"/api/board/{project}/messages"}, ViewGrantRoutes(), "a new route for a View person is added here on purpose, with Security's read")
	table := RoutePatterns()
	for _, p := range ViewGrantRoutes() {
		assert.Contains(t, table, "GET "+p+" view", p+" is a GET at the View tier in the table")
		assert.Contains(t, p, "{project}", p+" names a board")
	}
}

func TestViewGrantBoardNamesTheBoardOfAListedGetAndNothingElse(t *testing.T) {
	b, ok := ViewGrantBoard(http.MethodGet, "/api/board/team1/messages")
	require.True(t, ok)
	assert.Equal(t, "team1", b)
	b, ok = ViewGrantBoard(http.MethodHead, "/api/board/team1/messages")
	assert.True(t, ok)
	assert.Equal(t, "team1", b)
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/api/board/team1/messages"},        // a write
		{http.MethodGet, "/api/board/team1/messages/all"},     // a View route, but not on the list
		{http.MethodGet, "/api/board/team1/subscribers"},      // likewise
		{http.MethodGet, "/api/sessions/live"},                // the agent list: not yet
		{http.MethodGet, "/api/health"},                       // a route with no board
		{http.MethodGet, "/api/board/team1/messages/extra/x"}, // not a route at all
		{http.MethodGet, "/api/board//messages"},              // no board named
		{http.MethodGet, "/api/board/team1/tasks"},
	} {
		_, ok := ViewGrantBoard(c.method, c.path)
		assert.False(t, ok, c.method+" "+c.path)
	}
}
