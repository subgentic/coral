package routes

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// A goal's artifacts (#8575): the artifacts route takes ?goal=<id> (the artifacts of that goal's tasks) and says on every item which goal its task belongs to; the task list says how many
// artifacts each task's results reference. Both stand on the real route and store.
func TestTeamArtifactsByGoal(t *testing.T) {
	srv, h, _ := teamArtifactServer(t)
	ctx := context.Background()
	g1, err := h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Ship the installer", CreatedBy: "Operator"})
	require.NoError(t, err)
	g2, err := h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Fix the docs", CreatedBy: "Operator"})
	require.NoError(t, err)
	other, err := h.bs.CreateGoal(ctx, "beta", board.GoalInput{Title: "Another team's goal", CreatedBy: "Operator"})
	require.NoError(t, err)
	done := func(title string, goal *int64, arts ...board.TaskArtifact) int64 {
		task, err := h.bs.CreateTaskWithOpts(ctx, "alpha", title, "", "medium", "lead", &board.CreateTaskOpts{GoalID: goal})
		require.NoError(t, err, title)
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, "alpha", task.ID, "lead", nil, "success", arts)
		require.NoError(t, err, title)
		return task.ID
	}
	t1 := done("Build the installer", &g1.ID, board.TaskArtifact{Name: "installer.md", Content: "one"}, board.TaskArtifact{Name: "notes.md", Content: "two"})
	t2 := done("Sign it", &g1.ID, board.TaskArtifact{Name: "signature.txt", Content: "three"})
	done("Rewrite the docs", &g2.ID, board.TaskArtifact{Name: "docs.md", Content: "four"})
	done("A task with no goal", nil, board.TaskArtifact{Name: "loose.md", Content: "five"})

	names := func(q string) []string {
		t.Helper()
		got := getTeamArtifacts(t, srv, "/api/board/alpha/artifacts"+q, http.StatusOK)
		var out []string
		for _, a := range got.Artifacts {
			out = append(out, a.Name)
		}
		sort.Strings(out)
		return out
	}
	assert.Equal(t, []string{"installer.md", "notes.md", "signature.txt"}, names("?goal="+goalNum(g1.ID)), "a goal's artifacts are those of its tasks")
	assert.Equal(t, []string{"docs.md"}, names("?goal="+goalNum(g2.ID)))
	assert.Empty(t, names("?goal="+goalNum(other.ID)), "another team's goal number finds nothing here")
	assert.Equal(t, []string{"installer.md", "notes.md"}, names("?goal="+goalNum(g1.ID)+"&task="+goalNum(t1)), "the goal and the task filters meet")
	assert.Empty(t, names("?goal="+goalNum(g2.ID)+"&task="+goalNum(t1)))
	assert.Len(t, names("?limit=50"), 5, "without the parameter nothing changes: all five")

	// every item says its goal (and a task with none says nothing)
	all := getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=50&sort=name", http.StatusOK)
	byName := map[string]teamArtifact{}
	for _, a := range all.Artifacts {
		byName[a.Name] = a
	}
	assert.Equal(t, g1.ID, byName["installer.md"].GoalID)
	assert.Equal(t, "Ship the installer", byName["signature.txt"].GoalTitle)
	assert.Equal(t, t2, byName["signature.txt"].TaskID)
	assert.Equal(t, g2.ID, byName["docs.md"].GoalID)
	assert.Zero(t, byName["loose.md"].GoalID, "a task with no goal: no goal on its artifacts")
	assert.Empty(t, byName["loose.md"].GoalTitle)

	// a goal that is not a number is refused, not read as no filter
	for _, bad := range []string{"?goal=0", "?goal=abc", "?goal=-1", "?goal=1&goal=2"} {
		getTeamArtifacts(t, srv, "/api/board/alpha/artifacts"+bad, http.StatusBadRequest)
	}
}

// The task list's artifact_count (#8575): the distinct artifacts a task's results reference; nothing for a task with none.
func TestTaskListArtifactCount(t *testing.T) {
	_, h, _ := teamArtifactServer(t)
	ctx := context.Background()
	done := func(title string, arts ...board.TaskArtifact) int64 {
		task, err := h.bs.CreateTask(ctx, "alpha", title, "", "medium", "lead")
		require.NoError(t, err)
		if arts != nil {
			_, err = h.bs.CompleteTaskWithArtifacts(ctx, "alpha", task.ID, "lead", nil, "success", arts)
			require.NoError(t, err, title)
		}
		return task.ID
	}
	two := done("two inline", board.TaskArtifact{Name: "a.md", Content: "a"}, board.TaskArtifact{Name: "b.md", Content: "b"})
	same := done("one link twice", board.TaskArtifact{Name: "x.zip", URI: "https://example.com/x.zip"}, board.TaskArtifact{Name: "x-again.zip", URI: "https://example.com/x.zip"})
	mixed := done("a link and an inline", board.TaskArtifact{Name: "x.zip", URI: "https://example.com/y.zip"}, board.TaskArtifact{Name: "n.md", Content: "n"})
	none := done("no artifacts")
	page, err := h.bs.ListTaskPage(ctx, "alpha", board.TaskListQuery{Status: board.TaskListAll})
	require.NoError(t, err)
	got := map[int64]int{}
	for _, it := range page.Tasks {
		got[it.ID] = it.ArtifactCount
	}
	assert.Equal(t, 2, got[two])
	assert.Equal(t, 1, got[same], "the same link twice is one artifact")
	assert.Equal(t, 2, got[mixed])
	assert.Zero(t, got[none])
}

func goalNum(n int64) string { return strconv.FormatInt(n, 10) }
