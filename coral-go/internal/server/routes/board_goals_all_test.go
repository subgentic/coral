package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #7260 (part 2 of the #7245 note): GET /api/goals reads every board's goals in one call: oldest first by id, a real cursor bound to the filters, the board of each goal, the rollups from the whole
// page's one grouped read, and no tasks inside.
func TestAllGoalsReadPagesEveryBoard(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "alpha", "Orchestrator")
	registerTaskPlanner(t, h, "beta", "Orchestrator")
	var want []int64
	byBoard := map[int64]string{}
	for i := 0; i < 250; i++ {
		b := "alpha"
		if i%3 == 0 {
			b = "beta"
		}
		g, err := h.bs.CreateGoal(ctx, b, board.GoalInput{Title: fmt.Sprintf("goal %d", i), CreatedBy: "Orchestrator"})
		require.NoError(t, err)
		want = append(want, g.ID)
		byBoard[g.ID] = b
	}
	// two tasks on the first goal: the rollup comes with the page
	for i := 0; i < 2; i++ {
		_, err := h.bs.CreateTaskWithOpts(ctx, "alpha", "t", "", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &want[1]})
		require.NoError(t, err)
	}
	call := goalCall(t, server.URL)

	var got []int64
	cursor, pages := "", 0
	for {
		path := "/api/goals?limit=100"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		code, page := call("GET", path, nil)
		require.Equal(t, 200, code, "%v", page)
		pages++
		for _, row := range page["goals"].([]any) {
			g := row.(map[string]any)
			id := int64(g["id"].(float64))
			got = append(got, id)
			assert.Equal(t, byBoard[id], g["board_id"], "each goal says its board")
			assert.NotContains(t, g, "tasks", "goals only")
			if id == want[1] {
				assert.EqualValues(t, 2, g["rollup"].(map[string]any)["total"])
			}
		}
		cursor, _ = page["next_cursor"].(string)
		if cursor == "" {
			break
		}
		require.Less(t, pages, 10)
	}
	assert.Equal(t, want, got, "every goal of every board once, oldest first")
	assert.Equal(t, 3, pages)

	// board narrows (repeatable and comma separated); an unknown board is simply empty, like a board with no goals.
	for _, q := range []string{"board=beta", "board=beta&board=nope", "board=beta,nope"} {
		code, page := call("GET", "/api/goals?limit=200&"+q, nil)
		require.Equal(t, 200, code, q)
		for _, row := range page["goals"].([]any) {
			assert.Equal(t, "beta", row.(map[string]any)["board_id"], q)
		}
		assert.Len(t, page["goals"], 84, q)
	}
	code, page := call("GET", "/api/goals?board=nope", nil)
	assert.Equal(t, 200, code)
	assert.Empty(t, page["goals"])
	assert.Equal(t, "", page["next_cursor"])

	// state: closed goals only with state=done (as the per-board read), exact words.
	_, _, err := h.bs.CloseGoal(ctx, "alpha", want[1], "done", "")
	require.NoError(t, err)
	code, page = call("GET", "/api/goals?state=done", nil)
	require.Equal(t, 200, code)
	require.Len(t, page["goals"], 1)
	assert.EqualValues(t, want[1], page["goals"].([]any)[0].(map[string]any)["id"])
	code, _ = call("GET", "/api/goals?state=ACTIVE", nil)
	assert.Equal(t, 400, code)
}

func TestAllGoalsReadRefusals(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		_, err := h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: fmt.Sprintf("a%d", i), CreatedBy: "Orchestrator"})
		require.NoError(t, err)
		_, err = h.bs.CreateGoal(ctx, "beta", board.GoalInput{Title: fmt.Sprintf("b%d", i), CreatedBy: "Orchestrator"})
		require.NoError(t, err)
	}
	call := goalCall(t, server.URL)
	_, first := call("GET", "/api/goals?limit=2", nil)
	cur := url.QueryEscape(first["next_cursor"].(string))
	require.NotEmpty(t, cur)
	_, perBoard := call("GET", "/api/board/alpha/goals?limit=2", nil)
	perBoardCursor := url.QueryEscape(perBoard["next_cursor"].(string))

	many := func(n int) string {
		var parts []string
		for i := 0; i < n; i++ {
			parts = append(parts, fmt.Sprintf("board=b%d", i))
		}
		return strings.Join(parts, "&")
	}
	for name, q := range map[string]string{
		"a cursor for other states":  "state=done&limit=2&cursor=" + cur,
		"a cursor for another board": "board=alpha&limit=2&cursor=" + cur,
		"a per-board goal cursor":    "limit=2&cursor=" + perBoardCursor,
		"a made-up cursor":           "cursor=bogus",
		"limit zero":                 "limit=0",
		"limit negative":             "limit=-1",
		"limit text":                 "limit=abc",
		"a mistyped parameter":       "GOAL=1",
		"an unknown parameter":       "goal=1",
		"a list that is not a query": "limit=1;board=x",
		"a bad state":                "state=paused",
		"too many boards":            many(51),
		"an empty board":             "board=",
		"an empty state member":      "state=active,,blocked",
	} {
		code, out := call("GET", "/api/goals?"+q, nil)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	code, out := call("GET", "/api/goals?limit=100000", nil)
	assert.Equal(t, 200, code)
	assert.Len(t, out["goals"], 10, "a limit past the maximum is clamped")
	code, out = call("GET", "/api/goals?"+many(20), nil)
	assert.Equal(t, 200, code, "twenty boards is the cap: %v", out)
	code, out = call("GET", "/api/goals?limit=2&cursor="+cur, nil)
	assert.Equal(t, 200, code, "its own cursor still works: %v", out)
}
