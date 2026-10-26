package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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

// #8575: a task's own list (?task=<n>) holds what its row counts, so a file two tasks reference is on both; the team's list shows it once, under the newest.
func TestATasksArtifactListAgreesWithItsRowCountForASharedFile(t *testing.T) {
	srv, h, _ := teamArtifactServer(t)
	ctx := context.Background()
	shared := "coral://artifacts/" + "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"
	mk := func(title string, arts []board.TaskArtifact) int64 {
		task, err := h.bs.CreateTask(ctx, "g-team", title, "", "medium", "lead")
		require.NoError(t, err)
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, "g-team", task.ID, "lead", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	first := mk("first", []board.TaskArtifact{{Name: "shared.md", URI: shared}, {Name: "own.md", Content: "# own"}})
	second := mk("second", []board.TaskArtifact{{Name: "shared.md", URI: shared}})

	team := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?limit=50", http.StatusOK)
	require.Len(t, team.Artifacts, 2, "the team's list shows the shared file once")
	for _, id := range []int64{first, second} {
		list := getTeamArtifacts(t, srv, "/api/board/g-team/artifacts?task="+itoa(id), http.StatusOK)
		want := map[int64]int{first: 2, second: 1}[id]
		assert.Len(t, list.Artifacts, want, "task %d: its list is what its row counts", id)
	}
}
