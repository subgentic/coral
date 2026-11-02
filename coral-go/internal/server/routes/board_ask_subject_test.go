package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #12164 (the Operator: "attach the goal and task the question is about"): a question to the Operator (post --ask) can say which goal and which task it is about. The server checks both (the same team, ids that
// exist), keeps them on the ask, and /api/operator-asks and /api/needs-you return them; an agent that has exactly one claimed task attaches it (and its goal) without saying so.
func TestAQuestionToTheOperatorCarriesTheGoalAndTaskItIsAbout(t *testing.T) {
	srv, h := setupBoardTestServer(t)
	ctx := context.Background()
	bs := h.bs
	for _, who := range []string{"Lead", "Dev"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	_, err := bs.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "other", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	goal, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship the export", CreatedBy: "Lead"})
	require.NoError(t, err)
	otherGoal, err := bs.CreateGoal(ctx, "other", board.GoalInput{Title: "Another team's goal", CreatedBy: "Lead"})
	require.NoError(t, err)
	mk := func(title string, goalID *int64) *board.Task {
		tk, err := bs.CreateTaskWithOpts(ctx, "team", title, "", "medium", "Lead", &board.CreateTaskOpts{GoalID: goalID})
		require.NoError(t, err)
		return tk
	}
	task := mk("Write the exporter", &goal.ID)
	_, err = bs.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	otherTask, err := bs.CreateTaskWithOpts(ctx, "other", "Elsewhere", "", "medium", "Lead", nil)
	require.NoError(t, err)

	post := func(body map[string]any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		resp, err := http.Post(srv.URL+"/api/board/team/messages", "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	readAsks := func() []map[string]any {
		_, rows, _ := readOperatorAsks(t, h, asPerson)
		return rows
	}
	byText := func(text string) map[string]any {
		for _, r := range readAsks() {
			if s, _ := r["text"].(string); s != "" && bytes.Contains([]byte(s), []byte(text)) {
				return r
			}
		}
		t.Fatalf("no question with %q", text)
		return nil
	}

	// said explicitly (the Orchestrator's way)
	code, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator ship the first slice now?", "ask": true, "ask_goal": goal.ID, "ask_task": task.ID})
	require.Equal(t, http.StatusOK, code, out)
	row := byText("ship the first slice")
	assert.EqualValues(t, goal.ID, row["goal_id"])
	assert.EqualValues(t, task.ID, row["task_id"])
	assert.Equal(t, "Ship the export", row["goal_title"])
	assert.Equal(t, "Write the exporter", row["task_title"])

	// the same through the phone push
	req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
	w := httptest.NewRecorder()
	h.NeedsYou(w, req)
	var ny map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &ny))
	var item map[string]any
	for _, it := range needsYouItems(ny) {
		if it["kind"] == "question" {
			item = it
		}
	}
	require.NotNil(t, item)
	assert.EqualValues(t, goal.ID, item["goal_id"])
	assert.EqualValues(t, task.ID, item["task_id"])

	// a task named without its goal brings the task's own goal
	code, out = post(map[string]any{"subscriber_id": "Lead", "content": "@Operator only the task is named?", "ask": true, "ask_task": task.ID})
	require.Equal(t, http.StatusOK, code, out)
	onlyTask := byText("only the task is named")
	assert.EqualValues(t, task.ID, onlyTask["task_id"])
	assert.EqualValues(t, goal.ID, onlyTask["goal_id"], "the task's goal")

	// a question with neither carries neither
	code, _ = post(map[string]any{"subscriber_id": "Lead", "content": "@Operator plain question?", "ask": true})
	require.Equal(t, http.StatusOK, code)
	plain := byText("plain question")
	assert.Nil(t, plain["goal_id"])
	assert.Nil(t, plain["task_id"])

	// an agent with exactly one claimed task attaches it, and its goal, without saying so
	code, out = post(map[string]any{"subscriber_id": "Dev", "content": "@Operator may I drop the old format?", "ask": true})
	require.Equal(t, http.StatusOK, code, out)
	def := byText("drop the old format")
	assert.EqualValues(t, task.ID, def["task_id"], "its one claimed task")
	assert.EqualValues(t, goal.ID, def["goal_id"], "and that task's goal")
	// a member with no claimed task (Lead's plain question above) attaches nothing: nothing is guessed

	// refused: not this team's, not there, not a question, not whole numbers
	for name, body := range map[string]map[string]any{
		"another team's goal": {"ask": true, "ask_goal": otherGoal.ID},
		"another team's task": {"ask": true, "ask_task": otherTask.ID},
		"a goal that is not":  {"ask": true, "ask_goal": 99999},
		"a task that is not":  {"ask": true, "ask_task": 99999},
		"a negative goal":     {"ask": true, "ask_goal": -1},
		"not a question":      {"ask_goal": goal.ID},
	} {
		body["subscriber_id"], body["content"] = "Lead", "@Operator refused? "+name
		code, out := post(body)
		assert.Equal(t, http.StatusBadRequest, code, fmt.Sprintf("%s: %v", name, out))
	}
	for _, r := range readAsks() {
		assert.NotContains(t, r["text"], "refused?", "a refused post stores nothing")
	}
}
