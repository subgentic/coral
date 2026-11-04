package routes

import (
	"fmt"
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
