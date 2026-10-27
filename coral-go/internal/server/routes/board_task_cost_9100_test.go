package routes

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9100: what the Analytics By task table asks for. The plain GET /api/board/tasks sent the whole rows of the newest 100 tasks (long
// bodies and completion messages included) every 15 s; the table draws the tasks that have a cost, in 13 columns.
func TestTaskQueryHasCostAndCostFieldsAreTheTablesRead(t *testing.T) {
	e := newTQEnv(t)
	long := strings.Repeat("a long task description. ", 80) // 2 K, as a real task body is
	for i := 0; i < 60; i++ {
		set := "status = 'completed', completion_message = '" + long + "'"
		if i%3 == 0 { // a third of the tasks have a recorded cost
			set += ", cost_usd = 0.5, input_tokens = 1000, output_tokens = 200, cache_read_tokens = 300, cache_write_tokens = 40"
		}
		e.add("alpha", fmt.Sprintf("task %02d", i), long, "medium", "Orchestrator", "Dev", set)
	}
	const fields = "id,board_id,title,status,priority,assigned_to,claimed_at,completed_at,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens"

	code, out, narrow := e.get("has_cost=true&limit=100&fields=" + fields)
	require.Equal(t, 200, code, narrow)
	rows := out["tasks"].([]any)
	assert.Len(t, rows, 20, "only the tasks with a cost")
	first := rows[0].(map[string]any)
	assert.EqualValues(t, 0.5, first["cost_usd"])
	assert.EqualValues(t, 1000, first["input_tokens"])
	assert.EqualValues(t, 200, first["output_tokens"])
	assert.EqualValues(t, 300, first["cache_read_tokens"])
	assert.EqualValues(t, 40, first["cache_write_tokens"])
	assert.NotContains(t, first, "body", "no long text")
	assert.NotContains(t, first, "completion_message")

	_, _, plain := e.get("limit=100")
	assert.Greater(t, len(plain), 100_000, "the plain list: whole rows of every task (%d bytes)", len(plain))
	t.Logf("By task table read: %d bytes narrow, %d bytes plain", len(narrow), len(plain))
	assert.Less(t, len(narrow), 8_000, "the table's read: %d bytes", len(narrow))
	assert.Less(t, len(narrow)*15, len(plain), "at least 15 times smaller (%d against %d bytes)", len(narrow), len(plain))

	assert.Len(t, e.titles("has_cost=false&limit=100&fields=title"), 40, "has_cost=false is the tasks with none")
	code, _, body := e.get("has_cost=maybe")
	assert.Equal(t, 400, code)
	assert.Contains(t, body, "has_cost must be true or false")
}

// #9100: the team page's tab counts read the two totals alone. `?limit=1` returned every open task (and one done) to read them.
func TestBoardTaskCountsAreTheTotalsAlone(t *testing.T) {
	server, _ := setupBoardTestServer(t)
	base := server.URL + "/api/board/counts/tasks"
	long := strings.Repeat("a long task description. ", 80)
	for i := 0; i < 40; i++ {
		resp := postJSON(t, base, map[string]string{"title": fmt.Sprintf("open %d", i), "body": long, "subscriber_id": "Operator", "created_by": "Operator"})
		resp.Body.Close()
		require.Less(t, resp.StatusCode, 300)
	}
	read := func(q, etag string) (int, string, string) {
		req, _ := http.NewRequest(http.MethodGet, base+q, nil)
		if etag != "" {
			req.Header.Set("If-None-Match", etag)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), resp.Header.Get("ETag")
	}
	code, counts, etag := read("?counts=1", "")
	require.Equal(t, http.StatusOK, code, counts)
	assert.Contains(t, counts, `"total_open":40`)
	assert.Contains(t, counts, `"total_completed":0`)
	assert.Contains(t, counts, `"tasks":[]`, "no rows")
	assert.Less(t, len(counts), 200, "the totals alone: %d bytes", len(counts))

	_, old, _ := read("?limit=1", "")
	assert.Greater(t, len(old), 10_000, "the read it replaces held every open task (%d bytes)", len(old))
	t.Logf("team count read: %d bytes counts=1, %d bytes limit=1", len(counts), len(old))
	assert.Less(t, len(counts)*50, len(old), "at least 50 times smaller (%d against %d bytes)", len(counts), len(old))

	code, body, _ := read("?counts=1", etag)
	assert.Equal(t, http.StatusNotModified, code, "unchanged: a 304 with no body")
	assert.Empty(t, body)

	for _, q := range []string{"?counts=1&limit=5", "?counts=1&status=open", "?counts=1&cursor=x"} {
		code, body, _ := read(q, "")
		assert.Equal(t, http.StatusBadRequest, code, q)
		assert.Contains(t, body, "counts=1 is the totals alone")
	}
}
