package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #15412 (walk 23, M7: "goal 2's files and questions said Goal #1"; #15338 found no wrong join and the walk's data was gone). With two goals on one team, a task in goal 2 with a file, and a question about that
// task, every read that names a goal must name goal 2 (its id and its title): the Operator's questions, Needs you, and the team's files. Nothing may name goal 1, or a goal's number with no title.
func TestEveryReadNamesGoalTwoForGoalTwosFilesAndQuestions(t *testing.T) {
	srv, h := setupBoardTestServer(t)
	ctx := context.Background()
	bs := h.bs
	for _, who := range []string{"Lead", "Dev", "Operator"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	g1, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "First goal", CreatedBy: "Lead"})
	require.NoError(t, err)
	g2, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Second goal", CreatedBy: "Lead"})
	require.NoError(t, err)
	require.NotEqual(t, g1.ID, g2.ID)
	t1, err := bs.CreateTaskWithOpts(ctx, "team", "Task of one", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g1.ID})
	require.NoError(t, err)
	t2, err := bs.CreateTaskWithOpts(ctx, "team", "Task of two", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g2.ID})
	require.NoError(t, err)
	for _, c := range []struct {
		tk   *board.Task
		file string
	}{{t1, "one.md"}, {t2, "two.md"}} {
		_, err = bs.ClaimTask(ctx, "team", "Dev", c.tk.ID)
		require.NoError(t, err)
		_, err = bs.CompleteTaskWithArtifacts(ctx, "team", c.tk.ID, "Dev", nil, "success", []board.TaskArtifact{{Name: c.file, Content: "# " + c.file}})
		require.NoError(t, err)
	}

	ask := func(text string, goal, task int64) {
		b, _ := json.Marshal(map[string]any{"subscriber_id": "Lead", "content": "@Operator " + text, "ask": true, "ask_goal": goal, "ask_task": task})
		resp, err := http.Post(srv.URL+"/api/board/team/messages", "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
	}
	ask("question of one?", g1.ID, t1.ID)
	ask("question of two?", g2.ID, t2.ID)

	// the Operator's questions
	_, rows, _ := readOperatorAsks(t, h, asPerson)
	seen := 0
	for _, r := range rows {
		s, _ := r["text"].(string)
		switch {
		case bytes.Contains([]byte(s), []byte("question of two")):
			seen++
			assert.EqualValues(t, g2.ID, r["goal_id"])
			assert.Equal(t, "Second goal", r["goal_title"])
			assert.EqualValues(t, t2.ID, r["task_id"])
		case bytes.Contains([]byte(s), []byte("question of one")):
			seen++
			assert.EqualValues(t, g1.ID, r["goal_id"])
			assert.Equal(t, "First goal", r["goal_title"])
		}
	}
	require.Equal(t, 2, seen)

	// Needs you
	w := httptest.NewRecorder()
	h.NeedsYou(w, asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil)))
	var ny map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &ny))
	seen = 0
	for _, it := range needsYouItems(ny) {
		if l, _ := it["line"].(string); bytes.Contains([]byte(l), []byte("question of two")) {
			seen++
			assert.EqualValues(t, g2.ID, it["goal_id"])
			assert.Equal(t, "Second goal", it["goal_title"])
		}
	}
	assert.Equal(t, 1, seen, "goal 2's question is in Needs you with goal 2's id and title")

	// the files
	resp, err := http.Get(srv.URL + "/api/board/team/artifacts?limit=50")
	require.NoError(t, err)
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		var got struct {
			Artifacts []teamArtifact `json:"artifacts"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
		byName := map[string]teamArtifact{}
		for _, a := range got.Artifacts {
			byName[a.Name] = a
		}
		require.NotNil(t, byName["two.md"].GoalID)
		assert.Equal(t, g2.ID, *byName["two.md"].GoalID)
		assert.Equal(t, "Second goal", byName["two.md"].GoalTitle)
		require.NotNil(t, byName["one.md"].GoalID)
		assert.Equal(t, g1.ID, *byName["one.md"].GoalID)
	} else {
		t.Log("the test server does not serve the artifacts route; the files are pinned by team_artifacts_goal_test.go")
	}
}
