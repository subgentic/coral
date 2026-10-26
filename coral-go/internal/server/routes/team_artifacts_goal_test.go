package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #8579 (Goal #61): the artifacts of a goal. A goal filter on the team's artifacts, the goal on each row, and the file count on a task's list item.

func goalArtifactsEnv(t *testing.T) (srv *httptest.Server, g1, g2 *board.Goal, t1, t2, t3 int64) {
	t.Helper()
	srv, h, _ := teamArtifactServer(t)
	ctx := context.Background()
	var err error
	g1, err = h.bs.CreateGoal(ctx, "g-team", board.GoalInput{Title: "Ship the report", CreatedBy: "lead"})
	require.NoError(t, err)
	g2, err = h.bs.CreateGoal(ctx, "g-team", board.GoalInput{Title: "Tidy the docs", CreatedBy: "lead"})
	require.NoError(t, err)
	mk := func(title string, goal *board.Goal, arts []board.TaskArtifact) int64 {
		opts := &board.CreateTaskOpts{}
		if goal != nil {
			opts.GoalID = &goal.ID
		}
		task, err := h.bs.CreateTaskWithOpts(ctx, "g-team", title, "", "medium", "lead", opts, "lead")
		require.NoError(t, err)
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, "g-team", task.ID, "lead", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	t1 = mk("Write the report", g1, []board.TaskArtifact{{Name: "report.md", Content: "# report"}, {Name: "graph.txt", Content: "graph"}})
	t2 = mk("Fix the docs", g2, []board.TaskArtifact{{Name: "docs.md", Content: "# docs"}})
	t3 = mk("A task with no goal", nil, []board.TaskArtifact{{Name: "loose.md", Content: "# loose"}})
	return srv, g1, g2, t1, t2, t3
}

func TestTeamArtifactsCarryTheGoalOfTheirTaskAndFilterByIt(t *testing.T) {
	srv, g1, g2, t1, t2, t3 := goalArtifactsEnv(t)

	all := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?limit=50", http.StatusOK)
	byName := map[string]teamArtifact{}
	for _, a := range all.Artifacts {
		byName[a.Name] = a
	}
	require.Len(t, byName, 4)
	for _, name := range []string{"report.md", "graph.txt"} {
		require.NotNil(t, byName[name].GoalID, name)
		assert.Equal(t, g1.ID, *byName[name].GoalID, name)
		assert.Equal(t, "Ship the report", byName[name].GoalTitle, name)
		assert.Equal(t, t1, byName[name].TaskID)
	}
	require.NotNil(t, byName["docs.md"].GoalID)
	assert.Equal(t, g2.ID, *byName["docs.md"].GoalID)
	assert.Nil(t, byName["loose.md"].GoalID, "a task with no goal has none on its rows")
	assert.Empty(t, byName["loose.md"].GoalTitle)
	_ = t2
	_ = t3

	one := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?goal="+itoa(g1.ID), http.StatusOK)
	require.Len(t, one.Artifacts, 2, "only what the goal's tasks hold")
	for _, a := range one.Artifacts {
		require.NotNil(t, a.GoalID)
		assert.Equal(t, g1.ID, *a.GoalID)
	}
	other := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?goal="+itoa(g2.ID), http.StatusOK)
	require.Len(t, other.Artifacts, 1)
	assert.Equal(t, "docs.md", other.Artifacts[0].Name)
	none := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?goal=99999", http.StatusOK)
	assert.Empty(t, none.Artifacts, "a goal nothing works toward")
	both := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?goal="+itoa(g1.ID)+"&task="+itoa(t1)+"&q=graph", http.StatusOK)
	require.Len(t, both.Artifacts, 1, "the goal filter joins the others")
	assert.Equal(t, "graph.txt", both.Artifacts[0].Name)

	for _, bad := range []string{"goal=abc", "goal=0", "goal=-3", "goal=1&goal=2", "goal="} {
		getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?"+bad, http.StatusBadRequest)
	}
}

// The goal filter is a query: its reply has the total and pages by cursor, tied to the goal it was issued for.
func TestTeamArtifactsGoalFilterIsAQueryWithATotalAndACursorForThatGoal(t *testing.T) {
	srv, g1, g2, _, _, _ := goalArtifactsEnv(t)
	resp, err := http.Get(srv.URL + "/api/board/g-team/artifacts?goal=" + itoa(g1.ID) + "&limit=1")
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	assert.EqualValues(t, 2, out["total"], "a total, as for any query")
	cursor, _ := out["next_cursor"].(string)
	require.NotEmpty(t, cursor, "the second file of the goal is on a next page")
	// the cursor belongs to the goal it was issued for
	getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?goal="+itoa(g2.ID)+"&limit=1&cursor="+cursor, http.StatusBadRequest)
	next := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?goal="+itoa(g1.ID)+"&limit=1&cursor="+cursor, http.StatusOK)
	require.Len(t, next.Artifacts, 1)
}

func TestTaskListRowsCarryTheirArtifactCount(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/tasks", h.ListTasks)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()
	mk := func(title string, arts []board.TaskArtifact) int64 {
		task, err := h.bs.CreateTask(ctx, "count-team", title, "", "medium", "lead")
		require.NoError(t, err)
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, "count-team", task.ID, "lead", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	three := mk("three files", []board.TaskArtifact{{Name: "a", Content: "1"}, {Name: "b", Content: "2"}, {Name: "c", Content: "3"}})
	zero := mk("no files", nil)

	resp, err := http.Get(srv.URL + "/api/board/count-team/tasks?status=all&limit=50")
	require.NoError(t, err)
	defer resp.Body.Close()
	var list struct {
		Tasks []map[string]any `json:"tasks"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	var seen int
	for _, row := range list.Tasks {
		switch int64(row["id"].(float64)) {
		case three:
			seen++
			requireKeys(t, "a task with files", row, "id", "title", "status", "artifact_count")
			assert.EqualValues(t, 3, row["artifact_count"])
		case zero:
			seen++
			assert.NotContains(t, row, "artifact_count", "a task with none sends no key")
		}
	}
	assert.Equal(t, 2, seen)
}

// #8591: the task query (the Inbox and the dock lists) sends the count too, in a field list and on whole rows.
func TestTaskQueryRowsCarryTheirArtifactCountOverHTTP(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/tasks", h.ListAllTasks)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()
	mk := func(title string, arts []board.TaskArtifact) int64 {
		task, err := h.bs.CreateTask(ctx, "q-team", title, "", "medium", "lead")
		require.NoError(t, err)
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, "q-team", task.ID, "lead", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	three := mk("three files", []board.TaskArtifact{{Name: "a", Content: "1"}, {Name: "b", Content: "2"}, {Name: "c", Content: "3"}})
	zero := mk("no files", nil)

	rowsOf := func(query string) map[int64]map[string]any {
		resp, err := http.Get(srv.URL + "/api/board/tasks?board=q-team&" + query)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var list struct {
			Tasks []map[string]any `json:"tasks"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
		out := map[int64]map[string]any{}
		for _, row := range list.Tasks {
			out[int64(row["id"].(float64))] = row
		}
		return out
	}
	for _, query := range []string{"fields=id,title,artifact_count", ""} { // a field list (the Inbox, the dock), and the whole rows
		rows := rowsOf(query)
		requireKeys(t, "a task with files ("+query+")", rows[three], "id", "title", "artifact_count")
		assert.EqualValues(t, 3, rows[three]["artifact_count"], query)
		assert.NotContains(t, rows[zero], "artifact_count", "none: no key (%s)", query)
	}
}

// The count is what the task page's Artifacts section lists, everywhere (#8591): a task's results and the uploads linked to it, each stored object once.
func TestTheArtifactCountIsWhatTheTaskPageListsInEveryList(t *testing.T) {
	old := taskCountTTL
	taskCountTTL = 0
	t.Cleanup(func() { taskCountTTL = old })
	srv, h, coralDir := teamArtifactServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/tasks", h.ListTasks)
	r.Get("/api/board/tasks", h.ListAllTasks)
	lists := httptest.NewServer(r)
	t.Cleanup(lists.Close)
	ctx := context.Background()
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	goal, err := h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "A goal", CreatedBy: "Alice"})
	require.NoError(t, err)
	mk := func(title string, arts []board.TaskArtifact) int64 {
		task, err := h.bs.CreateTaskWithOpts(ctx, "alpha", title, "", "medium", "Alice", &board.CreateTaskOpts{GoalID: &goal.ID}, "Alice")
		require.NoError(t, err)
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, "alpha", task.ID, "Alice", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	inWorkflow := storeManagedArtifact(t, coralDir, "in the result", true, true)
	t1 := mk("task one", []board.TaskArtifact{{Name: "inline.md", Content: "# inline"}, {Name: "obj.md", URI: "coral://artifacts/" + inWorkflow}})
	t2 := mk("task two", []board.TaskArtifact{{Name: "only.md", Content: "# only"}})
	t3 := mk("task three, no results", nil)
	link := func(content string, task int64) string {
		id := storeManagedArtifact(t, coralDir, content, true, true)
		dir := uploadsDir(coralDir, sessAlice)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "up.md", MediaType: "text/markdown", Size: int64(len(content)), Digest: "sha256:" + id}, CreatedAt: "2026-10-09T10:00:00Z", TaskID: task})
		require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), rec, 0o644))
		return id
	}
	link("an upload linked to task one", t1)
	link("another upload linked to task one", t1)
	link("an upload linked to task three", t3) // a task with no results, only an upload
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "dup.md", MediaType: "text/markdown", Size: 1, Digest: "sha256:" + inWorkflow}, CreatedAt: "2026-10-09T10:00:00Z", TaskID: t1})
	dir := uploadsDir(coralDir, sessAlice)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, inWorkflow+".json"), rec, 0o644)) // the same object as a result of task one: one item

	sectionOf := func(task int64) int {
		return len(getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=200&task="+itoa(task), http.StatusOK).Artifacts)
	}
	want := map[int64]int{t1: sectionOf(t1), t2: sectionOf(t2), t3: sectionOf(t3)}
	require.Equal(t, map[int64]int{t1: 4, t2: 1, t3: 1}, want, "the section: 2 results, 2 uploads (the duplicate of a result is one item)")

	get := func(path string) []map[string]any {
		resp, err := http.Get(lists.URL + path)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, path)
		var out struct {
			Tasks []map[string]any `json:"tasks"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out.Tasks
	}
	check := func(what string, rows []map[string]any) {
		t.Helper()
		got := map[int64]int{}
		for _, row := range rows {
			if n, ok := row["artifact_count"].(float64); ok {
				got[int64(row["id"].(float64))] = int(n)
			}
		}
		assert.Equal(t, want, got, what)
	}
	check("the board's task list", get("/api/board/alpha/tasks?status=all&limit=50"))
	check("the goal's task list", get("/api/board/alpha/tasks?goal="+itoa(goal.ID)+"&status=all"))
	check("the all-boards list (whole rows)", get("/api/board/tasks"))
	check("the query's whole rows", get("/api/board/tasks?board=alpha&limit=50"))
	check("the query's field list (the Inbox and the dock)", get("/api/board/tasks?board=alpha&fields=id,board_id,artifact_count"))
	check("a search", get("/api/board/tasks?board=alpha&q=task&fields=id,artifact_count"))
}

// A board's counts are kept for a few seconds (the lists are polled; a scan costs what the Artifacts tab's does) and asked for afresh after.
func TestTaskArtifactCountsAreKeptForAFewSeconds(t *testing.T) {
	_, h, _ := teamArtifactServer(t)
	ctx := context.Background()
	old := taskCountTTL
	t.Cleanup(func() { taskCountTTL = old })
	taskCountTTL = time.Hour
	task, err := h.bs.CreateTask(ctx, "kept-team", "one", "", "medium", "lead")
	require.NoError(t, err)
	_, err = h.bs.CompleteTaskWithArtifacts(ctx, "kept-team", task.ID, "lead", nil, "success", []board.TaskArtifact{{Name: "a", Content: "1"}})
	require.NoError(t, err)
	assert.Equal(t, map[int64]int{task.ID: 1}, h.taskArtifactCounts(ctx, "kept-team"))

	task2, err := h.bs.CreateTask(ctx, "kept-team", "two", "", "medium", "lead")
	require.NoError(t, err)
	_, err = h.bs.CompleteTaskWithArtifacts(ctx, "kept-team", task2.ID, "lead", nil, "success", []board.TaskArtifact{{Name: "b", Content: "2"}})
	require.NoError(t, err)
	assert.Equal(t, map[int64]int{task.ID: 1}, h.taskArtifactCounts(ctx, "kept-team"), "inside the time: the answer kept")
	taskCountTTL = 0
	assert.Equal(t, map[int64]int{task.ID: 1, task2.ID: 1}, h.taskArtifactCounts(ctx, "kept-team"), "after it: asked afresh")
	assert.Empty(t, h.taskArtifactCounts(ctx, "another-team"), "a board's counts are its own")
}

// Two boards in one list (the Inbox's all-boards list): each row has the count of its own board's task, and a board's counts are kept under its own name (Security's #8591 review).
func TestArtifactCountsAreOfEachRowsOwnBoardInAnAllBoardsList(t *testing.T) {
	old := taskCountTTL
	taskCountTTL = time.Hour // the cache is in play: one board's answer must not serve the other
	t.Cleanup(func() { taskCountTTL = old })
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/tasks", h.ListAllTasks)
	r.Get("/api/board/{project}/tasks", h.ListTasks)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()
	mk := func(project, title string, n int) int64 {
		task, err := h.bs.CreateTask(ctx, project, title, "", "medium", "lead")
		require.NoError(t, err)
		var arts []board.TaskArtifact
		for i := 0; i < n; i++ {
			arts = append(arts, board.TaskArtifact{Name: "f" + itoa(int64(i)), Content: "c" + itoa(int64(i))})
		}
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, project, task.ID, "lead", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	x1, x2 := mk("board-x", "x one", 1), mk("board-x", "x two", 2)
	y1, y2 := mk("board-y", "y one", 3), mk("board-y", "y none", 0)
	want := map[int64]int{x1: 1, x2: 2, y1: 3}

	get := func(path string) map[int64]int {
		resp, err := http.Get(srv.URL + path)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, path)
		var out struct {
			Tasks []map[string]any `json:"tasks"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		got := map[int64]int{}
		for _, row := range out.Tasks {
			if n, ok := row["artifact_count"].(float64); ok {
				got[int64(row["id"].(float64))] = int(n)
			}
		}
		return got
	}
	// each board's own list first (filling the cache board by board), then the lists that mix them
	assert.Equal(t, map[int64]int{x1: 1, x2: 2}, get("/api/board/board-x/tasks?status=all"))
	assert.Equal(t, map[int64]int{y1: 3}, get("/api/board/board-y/tasks?status=all"))
	assert.Equal(t, want, get("/api/board/tasks"), "the all-boards list, whole rows")
	assert.Equal(t, want, get("/api/board/tasks?fields=id,board_id,artifact_count&limit=50"), "a field list across boards")
	assert.Equal(t, want, get("/api/board/tasks?limit=50"), "the query's whole rows")
	_ = y2
}
