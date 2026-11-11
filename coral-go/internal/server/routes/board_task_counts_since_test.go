package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15340 (walk 23 M8: the Tasks tab said 5 on the Goals and Board tabs, the Tasks page said Open 7): the page's Open is the open tasks plus the ones finished today, but the tab's count read only the server's open total
// until the list had been read. counts=1 takes the client's start of today (since) and says how many tasks were completed since: the tab adds them, so it says the list's number from its first read.
func TestTaskCountsSaySinceWhenHowManyWereCompleted(t *testing.T) {
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/since-counts/tasks"
	var ids []float64
	for _, title := range []string{"one", "two", "three"} {
		resp := postJSON(t, base, map[string]string{"title": title, "body": "a task", "subscriber_id": "Operator", "created_by": "Operator"})
		var made map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&made))
		resp.Body.Close()
		require.Less(t, resp.StatusCode, 300)
		id, _ := made["id"].(float64)
		if id == 0 {
			id, _ = made["task_id"].(float64)
		}
		require.NotZero(t, id, "%v", made)
		ids = append(ids, id)
	}
	for _, id := range ids[:2] { // two are finished now
		for _, step := range []struct {
			path string
			body map[string]any
		}{{"/claim", map[string]any{"subscriber_id": "Orchestrator", "task_id": id}}, {"/" + strconv.Itoa(int(id)) + "/complete", map[string]any{"subscriber_id": "Orchestrator", "message": "done", "outcome": "success"}}} {
			resp := postJSON(t, base+step.path, step.body)
			resp.Body.Close()
			require.Less(t, resp.StatusCode, 300, step.path)
		}
	}
	// a fourth task is skipped now: it has a completed_at but is not "finished today" (the page's Open leaves it out too), so it must not be counted
	resp := postJSON(t, base, map[string]string{"title": "four", "body": "a task", "subscriber_id": "Operator", "created_by": "Operator"})
	var four map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&four))
	resp.Body.Close()
	fourID, _ := four["id"].(float64)
	if fourID == 0 {
		fourID, _ = four["task_id"].(float64)
	}
	require.NotZero(t, fourID, "%v", four)
	outside, err := sqlx.Open("sqlite", boardTestDBPath(h))
	require.NoError(t, err)
	_, err = outside.Exec(`UPDATE board_tasks SET status='skipped', completed_at=? WHERE id=?`, time.Now().UTC().Format(time.RFC3339), int(fourID))
	outside.Close()
	require.NoError(t, err)
	read := func(since string) (int, map[string]any) {
		q := "?counts=1"
		if since != "" {
			q += "&since=" + url.QueryEscape(since)
		}
		resp, err := http.Get(base + q)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return resp.StatusCode, out
	}
	code, out := read(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339))
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 1, out["total_open"])
	assert.EqualValues(t, 3, out["total_completed"], "two completed and one skipped")
	assert.EqualValues(t, 2, out["completed_since"], "the two finished within the hour (the skipped one is not counted): the page's Open is 1 + 2")
	_, out = read(time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	assert.EqualValues(t, 0, out["completed_since"], "nothing finished after a later start")
	_, out = read("")
	assert.NotContains(t, out, "completed_since", "no since: the totals alone, as before")
	code, _ = read("yesterday")
	assert.Equal(t, http.StatusBadRequest, code)
}
