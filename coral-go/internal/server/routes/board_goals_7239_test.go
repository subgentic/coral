package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #7239 (QA's #7236 points 3 to 7): the goals reads and the PATCH, as a client sees them.

func TestGoalIdsAreCanonicalDecimalOnly(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	_, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Ids", "subscriber_id": "Orchestrator"})
	gid := itoa(int64(g["id"].(float64)))
	task, err := h.bs.CreateTask(ctx, "team", "t", "", "medium", "Orchestrator")
	require.NoError(t, err)
	tid := itoa(task.ID)

	for _, spelling := range []string{"0" + gid, "+" + gid, "%2B" + gid, gid + ".0", "0x" + gid, "%20" + gid, gid + "%20"} {
		code, out := call("GET", "/api/board/team/goals/"+spelling, nil)
		assert.Equal(t, 400, code, "goal id %q: %v", spelling, out)
		code, out = call("GET", "/api/board/team/tasks?goal="+spelling, nil)
		assert.Equal(t, 400, code, "goal= %q: %v", spelling, out)
		code, out = call("PUT", "/api/board/team/tasks/"+spelling+"/goal", map[string]any{"goal_id": nil, "subscriber_id": "Orchestrator"})
		assert.Equal(t, 400, code, "task id %q: %v", spelling, out)
	}
	code, out := call("GET", "/api/board/team/goals/"+gid, nil)
	assert.Equal(t, 200, code, "%v", out)
	code, out = call("PUT", "/api/board/team/tasks/"+tid+"/goal", map[string]any{"goal_id": g["id"], "subscriber_id": "Orchestrator"})
	assert.Equal(t, 200, code, "%v", out)
	code, out = call("GET", "/api/board/team/tasks?goal="+gid, nil)
	assert.Equal(t, 200, code, "%v", out)
}

func TestGoalListPagesWithACursor(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	var want []int64
	for i := 0; i < 130; i++ {
		g, err := h.bs.CreateGoal(ctx, "team", board.GoalInput{Title: fmt.Sprintf("goal %d", i), CreatedBy: "Orchestrator"})
		require.NoError(t, err)
		want = append(want, g.ID)
	}
	code, first := call("GET", "/api/board/team/goals", nil)
	require.Equal(t, 200, code, "%v", first)
	assert.Len(t, goalsOf(t, first), 50, "the default page is 50, the task list's")
	assert.NotEmpty(t, first["next_cursor"])
	code, big := call("GET", "/api/board/team/goals?limit=100000", nil)
	require.Equal(t, 200, code)
	assert.Len(t, goalsOf(t, big), 130, "limit is clamped to 200, which holds them all")
	assert.Equal(t, "", big["next_cursor"], "empty on the last page, and present")
	_, has := big["next_cursor"]
	assert.True(t, has)

	var got []int64
	cursor := ""
	for pages := 0; ; pages++ {
		require.Less(t, pages, 10)
		path := "/api/board/team/goals?limit=50"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		_, page := call("GET", path, nil)
		for _, g := range goalsOf(t, page) {
			got = append(got, int64(g["id"].(float64)))
		}
		if cursor, _ = page["next_cursor"].(string); cursor == "" {
			break
		}
	}
	assert.Equal(t, want, got, "every goal once, oldest first")

	cur := first["next_cursor"].(string)
	for _, bad := range []string{"/goals?cursor=bogus", "/goals?state=done&cursor=" + cur, "/goals?state=active,done&cursor=" + cur, "/goals?limit=0", "/goals?limit=x"} {
		code, out := call("GET", "/api/board/team"+bad, nil)
		assert.Equal(t, 400, code, "%s: %v", bad, out)
	}
	// the states in another order are the same filter
	_, a := call("GET", "/api/board/team/goals?state=proposed,active&limit=1", nil)
	code, out := call("GET", "/api/board/team/goals?state=active,proposed&limit=1&cursor="+a["next_cursor"].(string), nil)
	assert.Equal(t, 200, code, "%v", out)
	// a goal cursor on the task list, and the task list's cursor here
	code, _ = call("GET", "/api/board/team/tasks?cursor="+cur, nil)
	assert.Equal(t, 400, code)
}

func TestGoalTasksReadHonoursStatusAndRefusesOtherFilters(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	_, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Filters", "subscriber_id": "Orchestrator"})
	gid := int64(g["id"].(float64))
	for i := 0; i < 3; i++ {
		_, err := h.bs.CreateTaskWithOpts(ctx, "team", fmt.Sprintf("t%d", i), "", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &gid})
		require.NoError(t, err)
	}
	done, err := h.bs.ClaimTask(ctx, "team", "Dev", 0)
	require.NoError(t, err)
	_, err = h.bs.CompleteTask(ctx, "team", done.ID, "Dev", nil)
	require.NoError(t, err)

	count := func(q string) int {
		t.Helper()
		code, out := call("GET", "/api/board/team/tasks?goal="+itoa(gid)+q, nil)
		require.Equal(t, 200, code, "%s: %v", q, out)
		return len(out["tasks"].([]any))
	}
	assert.Equal(t, 3, count(""))
	assert.Equal(t, 3, count("&status=all"))
	assert.Equal(t, 2, count("&status=open"))
	assert.Equal(t, 1, count("&status=completed"))
	code, out := call("GET", "/api/board/team/tasks?goal="+itoa(gid)+"&status=open", nil)
	assert.EqualValues(t, 2, out["total_open"], "the totals stay the goal's")
	assert.EqualValues(t, 1, out["total_completed"], "%d", code)

	for _, bad := range []string{"&status=bogus", "&assigned_to=Dev", "&priority=high", "&q=x", "&sort=id", "&" + strings.Repeat("k", 80) + "=1"} {
		code, out := call("GET", "/api/board/team/tasks?goal="+itoa(gid)+bad, nil)
		assert.Equal(t, 400, code, "%s: %v", bad, out)
	}
	_, out = call("GET", "/api/board/team/tasks?goal="+itoa(gid)+"&assigned_to=Dev", nil)
	assert.Contains(t, fmt.Sprint(out["error"]), "assigned_to", "the refusal names the key")

	// a cursor holds the status it was issued for
	_, p := call("GET", "/api/board/team/tasks?goal="+itoa(gid)+"&status=open&limit=1", nil)
	cur := p["next_cursor"].(string)
	require.NotEmpty(t, cur)
	code, out = call("GET", "/api/board/team/tasks?goal="+itoa(gid)+"&status=all&limit=1&cursor="+cur, nil)
	assert.Equal(t, 400, code, "%v", out)
	code, _ = call("GET", "/api/board/team/tasks?goal="+itoa(gid)+"&status=open&limit=1&cursor="+cur, nil)
	assert.Equal(t, 200, code)
}

func TestGoalPatchRefusesFieldsItDoesNotHave(t *testing.T) {
	server, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	_, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Patch", "subscriber_id": "Orchestrator"})
	path := "/api/board/team/goals/" + itoa(int64(g["id"].(float64)))
	for _, field := range []string{"closed_at", "goal_uid", "board_id", "id", "created_by", "titel", "rollup"} {
		code, out := call("PATCH", path, map[string]any{field: "x", "subscriber_id": "Orchestrator"})
		assert.Equal(t, 400, code, "%s: %v", field, out)
		assert.Contains(t, fmt.Sprint(out["error"]), field, "the refusal names the field")
	}
	code, out := call("PATCH", path, map[string]any{"title": "Patched", "subscriber_id": "Orchestrator"})
	assert.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "Patched", out["title"])
}
