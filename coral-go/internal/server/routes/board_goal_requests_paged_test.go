package routes

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13289: the goal-requests list says how many there are and where the next page starts (newest first); with no limit it answers as it did (up to 100).
func TestGoalRequestsListPagesWithATotalAndACursor(t *testing.T) {
	call, h, goal := goalRequestEnv(t)
	const n = 7
	for i := 0; i < n; i++ { // through the store: the send route is rate limited per board
		_, _, err := h.bs.SendGoalRequest(t.Context(), "alpha", goal, "beta", fmt.Sprintf("ask number %d", i), "Orchestrator A", func(s string) string { return s })
		require.NoError(t, err)
	}
	code, all := call("GET", "/api/board/beta/goal-requests", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, all["requests"], n, "no limit: every one (under 100), as before")
	assert.EqualValues(t, n, all["total"])
	assert.Equal(t, false, all["has_more"])
	assert.Nil(t, all["next_cursor"])

	seen := map[float64]bool{}
	path, pages, last := "/api/board/beta/goal-requests?limit=3", 0, 0.0
	for {
		code, p := call("GET", path, nil)
		require.Equal(t, http.StatusOK, code, p)
		pages++
		assert.EqualValues(t, n, p["total"])
		for _, x := range p["requests"].([]any) {
			id := x.(map[string]any)["id"].(float64)
			require.False(t, seen[id], "sent once")
			seen[id] = true
			if last != 0 {
				assert.Less(t, id, last, "newest first")
			}
			last = id
		}
		if p["has_more"] != true {
			assert.Nil(t, p["next_cursor"])
			break
		}
		require.Len(t, p["requests"], 3)
		path = "/api/board/beta/goal-requests?limit=3&cursor=" + p["next_cursor"].(string)
		require.Less(t, pages, 6)
	}
	assert.Len(t, seen, n)
	assert.Equal(t, 3, pages)

	// exactly one page: no more, no cursor
	_, p := call("GET", "/api/board/beta/goal-requests?limit=7", nil)
	assert.Equal(t, false, p["has_more"])
	assert.Nil(t, p["next_cursor"])

	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, bad := range []string{"limit=0", "limit=201", "limit=x", "cursor=!!!", "cursor=" + b64("5"), "cursor=" + b64("i:0"), "cursor=" + b64("i:-2"), "cursor=" + b64("i:"+strings.Repeat("0", 800)+"5"), "cursor=" + strings.Repeat("A", 1100)} {
		code, _ := call("GET", "/api/board/beta/goal-requests?"+bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	code, _ = call("GET", "/api/board/beta/goal-requests?cursor="+b64("i:"+strings.Repeat("0", 765)+"5"), nil) // 1,024 characters: accepted
	assert.Equal(t, http.StatusOK, code, "exactly 1,024 characters")
}
