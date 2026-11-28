package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func readAnswered(t *testing.T, h *BoardHandler, query string, mod func(*http.Request) *http.Request) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/operator-asks?"+query, nil)
	if mod != nil {
		req = mod(req)
	}
	w := httptest.NewRecorder()
	h.OperatorAsks(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// #22106: the questions about one goal that the Operator answered, newest first, with their answer text, paged; owner-only; the open list is unchanged.
func TestOperatorAsksAnsweredListsOneGoalsAnsweredQuestionsWithTheirAnswers(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	const leadSession = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b"
	_, err := bs.Subscribe(ctx, "team", "Lead", "Lead", "claude-"+leadSession, nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	goal, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Checkout", CreatedBy: "Lead"})
	require.NoError(t, err)
	other, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Emails", CreatedBy: "Lead"})
	require.NoError(t, err)
	task, err := bs.CreateTaskWithOpts(ctx, "team", "Guest checkout", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &goal.ID})
	require.NoError(t, err)
	ask := func(text string, goalID, taskID int64) *board.Message {
		q, err := bs.PostMessage(ctx, "team", "Lead", text, nil)
		require.NoError(t, err)
		to, err := bs.AskTargets(ctx, "team", "Lead", q.Content)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
		require.NoError(t, bs.RecordAskSubject(ctx, "team", q.ID, goalID, taskID, true))
		return q
	}
	answer := func(q *board.Message, text string) {
		r, err := bs.PostMessage(ctx, "team", "Operator", text, nil)
		require.NoError(t, err)
		require.NoError(t, bs.RecordReply(ctx, "team", r.ID, q.ID))
	}
	q1 := ask("@Operator keep the phone field?", goal.ID, task.ID)
	q2 := ask("@Operator which copy for guests?", goal.ID, 0)
	ask("@Operator still open?", goal.ID, 0)        // not answered
	q4 := ask("@Operator other goal?", other.ID, 0) // another goal
	answer(q1, "Keep it, optional")
	answer(q2, "The short one")
	answer(q4, "yes")

	code, out := readAnswered(t, h, "board=team&goal="+itoa(goal.ID)+"&state=answered", asPerson)
	require.Equal(t, http.StatusOK, code, out)
	asks := out["asks"].([]any)
	require.Len(t, asks, 2, "answered ones of this goal only")
	first, second := asks[0].(map[string]any), asks[1].(map[string]any)
	assert.EqualValues(t, q2.ID, first["id"], "newest first")
	assert.Equal(t, "The short one", first["answer_text"])
	assert.NotEmpty(t, first["answered_at"])
	assert.EqualValues(t, q1.ID, second["id"])
	assert.Equal(t, "Keep it, optional", second["answer_text"])
	assert.EqualValues(t, task.ID, second["task_id"])
	assert.Equal(t, "Guest checkout", second["task_title"])
	assert.Equal(t, "Checkout", second["goal_title"])
	assert.Equal(t, "Lead", second["asker"])
	assert.Equal(t, leadSession, second["session_id"], "the asking agent's session, to open it")
	assert.Equal(t, false, out["has_more"])

	// paged: one at a time, the cursor gives the next
	_, p1 := readAnswered(t, h, "board=team&goal="+itoa(goal.ID)+"&state=answered&limit=1", asPerson)
	assert.Equal(t, true, p1["has_more"])
	require.Len(t, p1["asks"].([]any), 1)
	_, p2 := readAnswered(t, h, "board=team&goal="+itoa(goal.ID)+"&state=answered&limit=1&cursor="+p1["next_cursor"].(string), asPerson)
	require.Len(t, p2["asks"].([]any), 1)
	assert.EqualValues(t, q1.ID, p2["asks"].([]any)[0].(map[string]any)["id"])
	assert.Equal(t, false, p2["has_more"])

	// the open list is unchanged: a bare array with the open question only
	code, rows, _ := readOperatorAsks(t, h, asPerson)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, rows, 1)
}

func TestOperatorAsksAnsweredRefusesBadInputAndNonOwners(t *testing.T) {
	h, _ := operatorAsksRig(t)
	for _, q := range []string{"state=open", "state=answered", "state=answered&board=team", "state=answered&board=team&goal=0", "state=answered&board=team&goal=x",
		"state=answered&board=team&goal=1&limit=0", "state=answered&board=team&goal=1&limit=101", "state=answered&board=team&goal=1&cursor=!!"} {
		code, _ := readAnswered(t, h, q, asPerson)
		assert.Equal(t, http.StatusBadRequest, code, q)
	}
	code, out := readAnswered(t, h, "state=answered&board=nope&goal=1", asPerson)
	assert.Equal(t, http.StatusOK, code)
	assert.Empty(t, out["asks"], "an unknown team has none")
	code, _ = readAnswered(t, h, "state=answered&board=team&goal=1", nil)
	assert.NotEqual(t, http.StatusOK, code, "not the person: refused as the open list is")
}
