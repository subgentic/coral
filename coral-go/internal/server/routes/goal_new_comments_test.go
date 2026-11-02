package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #12073 (follow-up of #12026): a goal's own comment threads are the document comments pointed at a goal (the subject key goal:<team>:<id>), so an agent's reply in a thread the Operator started on a goal is "new
// comments" on that goal's row, as on a file's: the goal as the Operator's list and the single goal answer carry new_comments, and the "Goal looks done" item of Needs you does (the same row, not a new one).
func TestAGoalWithNewCommentsSaysSoToTheOperatorAlone(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.PostMessage(ctx, "team", "Lead", "hello", nil)
	require.NoError(t, err)
	g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship the export", CreatedBy: "Lead"})
	require.NoError(t, err)
	other, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Quiet goal", CreatedBy: "Lead"})
	require.NoError(t, err)
	tk, err := bs.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "team", "Dev", tk.ID)
	require.NoError(t, err)
	_, err = bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
	require.NoError(t, err)
	news := map[string]int{}
	h.goalDoneNow = quietPassed
	h.SetCommentNews(func(context.Context) (map[string]int, error) { return news, nil })

	person := chi.NewRouter()
	person.Get("/api/board/{project}/goals", func(w http.ResponseWriter, req *http.Request) { h.ListGoals(w, asPerson(req)) })
	person.Get("/api/board/{project}/goals/{goalID}", func(w http.ResponseWriter, req *http.Request) { h.GetGoal(w, asPerson(req)) })
	anyone := chi.NewRouter()
	anyone.Get("/api/board/{project}/goals", h.ListGoals)
	anyone.Get("/api/board/{project}/goals/{goalID}", h.GetGoal)
	ps, as := httptest.NewServer(person), httptest.NewServer(anyone)
	t.Cleanup(ps.Close)
	t.Cleanup(as.Close)
	get := func(url string) map[string]any {
		resp, err := http.Get(url)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}
	goalRow := func(srv string, id int64) map[string]any {
		for _, x := range get(srv + "/api/board/team/goals")["goals"].([]any) {
			if int64(x.(map[string]any)["id"].(float64)) == id {
				return x.(map[string]any)
			}
		}
		t.Fatalf("goal %d not listed", id)
		return nil
	}

	assert.Nil(t, goalRow(ps.URL, g.ID)["new_comments"], "no news, no field")
	news[goalSubject("team", g.ID)] = 2
	assert.EqualValues(t, 2, goalRow(ps.URL, g.ID)["new_comments"], "the Operator's list says it")
	assert.Nil(t, goalRow(ps.URL, other.ID)["new_comments"], "another goal has none")
	assert.EqualValues(t, 2, get(fmt.Sprintf("%s/api/board/team/goals/%d", ps.URL, g.ID))["new_comments"], "and the goal's own page")
	assert.Nil(t, goalRow(as.URL, g.ID)["new_comments"], "an agent's or guest's list never has it")
	assert.Nil(t, get(fmt.Sprintf("%s/api/board/team/goals/%d", as.URL, g.ID))["new_comments"])

	// the "Goal looks done" item of Needs you carries it: the same row
	req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
	w := httptest.NewRecorder()
	h.NeedsYou(w, req)
	var out map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	var item map[string]any
	for _, it := range needsYouItems(out) {
		if it["kind"] == "goal_done" {
			item = it
		}
	}
	require.NotNil(t, item, "the goal looks done")
	assert.EqualValues(t, 2, item["new_comments"])
	assert.Equal(t, fmt.Sprintf("goal_done:team:%d", g.ID), item["id"], "the same row")
}
