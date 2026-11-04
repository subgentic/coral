package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13188: the plain GET /api/board/tasks (no filters) keeps its answer (the newest 100, up to 500 whole rows, "tasks" first) and now says how many tasks there are and where the next page starts.
func TestPlainAllTasksSaysTheTotalAndWhereTheNextPageStarts(t *testing.T) {
	e := newTQEnv(t)
	const n = 130
	for i := 0; i < n; i++ {
		e.add(fmt.Sprintf("b%d", i%3), fmt.Sprintf("t%03d", i), "body", "medium", "Orchestrator", "", fmt.Sprintf("created_at = '2026-10-10T%02d:%02d:00Z'", i/60, i%60))
	}

	code, out, body := e.get("")
	require.Equal(t, 200, code, body)
	tasks := out["tasks"].([]any)
	assert.Len(t, tasks, 100, "no limit: the default 100, as before")
	assert.EqualValues(t, n, out["total"])
	assert.Equal(t, true, out["has_more"])
	assert.Equal(t, "t129", tasks[0].(map[string]any)["title"], "newest first, as before")
	assert.NotEmpty(t, out["next_cursor"])
	assert.NotNil(t, tasks[0].(map[string]any)["body"], "whole rows, as before")

	_, big, _ := e.get("limit=500")
	assert.Len(t, big["tasks"], n, "limit up to 500 still answers that many")
	assert.Equal(t, false, big["has_more"])
	assert.Nil(t, big["next_cursor"])

	// the cursor continues with no gap and no repeat
	seen := map[string]bool{}
	for _, r := range tasks {
		seen[r.(map[string]any)["title"].(string)] = true
	}
	code, next, body := e.get("cursor=" + out["next_cursor"].(string))
	require.Equal(t, 200, code, body)
	for _, r := range next["tasks"].([]any) {
		title := r.(map[string]any)["title"].(string)
		assert.False(t, seen[title], "sent once: "+title)
		seen[title] = true
	}
	assert.Len(t, seen, n)
}

// Security's whole-list check (#13188): with 100 long-bodied tasks the answer with no parameter holds the same rows, in the same order, as the old store call it replaced.
func TestPlainAllTasksReturnsTheSameRowsAsTheOldCallForLongBodies(t *testing.T) {
	e := newTQEnv(t)
	long := strings.Repeat("a long body line, ", 600) // ~10 KB
	for i := 0; i < 100; i++ {
		e.add(fmt.Sprintf("b%d", i%4), fmt.Sprintf("long %03d", i), fmt.Sprintf("%s#%d", long, i), []string{"low", "medium", "high", "critical"}[i%4], "Orchestrator", "", fmt.Sprintf("created_at = '2026-10-10T%02d:%02d:00Z'", i/60, i%60))
	}
	old, err := e.bs.ListAllTasks(context.Background(), 100)
	require.NoError(t, err)
	require.Len(t, old, 100)

	code, out, body := e.get("")
	require.Equal(t, 200, code, body)
	rows := out["tasks"].([]any)
	require.Len(t, rows, 100)
	assert.Equal(t, false, out["has_more"], "exactly 100 of 100: nothing more")
	for i, o := range old {
		raw, err := json.Marshal(o) // the old call's row as the old answer sent it
		require.NoError(t, err)
		var want map[string]any
		require.NoError(t, json.Unmarshal(raw, &want))
		r := rows[i].(map[string]any)
		for _, k := range []string{"id", "title", "body", "status", "priority", "board_id", "created_at"} {
			assert.Equal(t, want[k], r[k], "row %d, %s (same order, the long body whole)", i, k)
		}
	}
}
