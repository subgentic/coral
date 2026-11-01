package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11866 (beta #11837, #5): a goal made by anyone but the team's Orchestrator tells the Orchestrator, once, as a board message that mentions it and names the command that shows the goal; the goal keeps when it was told
// (orchestrator_told_at) so its page can say "The Orchestrator was told N min ago". Before this only a driver was told: a goal with none told nobody.
func TestACreatedGoalTellsTheOrchestratorOnce(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	_, err := h.bs.Subscribe(ctx, "team", "Dev", "Developer", "", nil, "mentions", false)
	require.NoError(t, err)
	call := goalCall(t, server.URL)
	toldNew := func() []string {
		t.Helper()
		h.WaitBackground()
		msgs, err := h.bs.ListMessages(ctx, "team", 100, 0, 0)
		require.NoError(t, err)
		var out []string
		for _, m := range msgs {
			if strings.Contains(m.Content, "new goal") {
				out = append(out, m.Content)
			}
		}
		return out
	}

	// The Operator makes a goal with no driver: the Orchestrator is told, and the goal says when.
	code, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Phone comments", "outcome": "o", "done_when": "d", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	id := itoa(int64(g["id"].(float64)))
	assert.NotEmpty(t, g["orchestrator_told_at"], "the reply says when it was told")
	msgs := toldNew()
	require.Len(t, msgs, 1, "%v", msgs)
	assert.Contains(t, msgs[0], "@Orchestrator")
	assert.Contains(t, msgs[0], "Phone comments")
	assert.Contains(t, msgs[0], "coral-board goal show "+id)
	code, got := call("GET", "/api/board/team/goals/"+id, nil)
	require.Equal(t, 200, code)
	told := got["orchestrator_told_at"]
	assert.NotEmpty(t, told, "and the goal keeps it")

	// Any later change says nothing more, and the time does not move.
	code, _ = call("PATCH", "/api/board/team/goals/"+id, map[string]any{"outcome": "a new outcome", "subscriber_id": "Operator"})
	require.Equal(t, 200, code)
	code, _ = call("PATCH", "/api/board/team/goals/"+id, map[string]any{"driver": "Dev", "subscriber_id": "Operator"})
	require.Equal(t, 200, code)
	assert.Len(t, toldNew(), 1)
	_, got = call("GET", "/api/board/team/goals/"+id, nil)
	assert.Equal(t, told, got["orchestrator_told_at"])

	// A goal with another agent as driver tells both: the driver (as before) and the Orchestrator.
	code, g = call("POST", "/api/board/team/goals", map[string]any{"title": "Second", "outcome": "o", "done_when": "d", "driver": "Dev", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	assert.Len(t, toldNew(), 2)

	// The Orchestrator as driver is told once, as the driver (that message is the told-at).
	code, g = call("POST", "/api/board/team/goals", map[string]any{"title": "Third", "outcome": "o", "done_when": "d", "driver": "Orchestrator", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	assert.Len(t, toldNew(), 2, "no second message for the same agent")
	assert.NotEmpty(t, g["orchestrator_told_at"])

	// The Orchestrator's own goal tells no one, and keeps no told-at.
	code, g = call("POST", "/api/board/team/goals", map[string]any{"title": "Mine", "outcome": "o", "done_when": "d", "subscriber_id": "Orchestrator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	assert.Len(t, toldNew(), 2)
	assert.Empty(t, g["orchestrator_told_at"])
}

func TestAGoalOnATeamWithNoOrchestratorTellsNoOne(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "solo", "Dev", "Developer", "", nil, "mentions", false)
	require.NoError(t, err)
	call := goalCall(t, server.URL)
	code, g := call("POST", "/api/board/solo/goals", map[string]any{"title": "Alone", "outcome": "o", "done_when": "d", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	h.WaitBackground()
	assert.Empty(t, g["orchestrator_told_at"])
	msgs, err := h.bs.ListMessages(ctx, "solo", 100, 0, 0)
	require.NoError(t, err)
	for _, m := range msgs {
		assert.NotContains(t, m.Content, "new goal")
	}
}

// A proposed goal is not told (it is not a goal the team works on yet); it is when it becomes active, once. A goal made before this existed, or any other change to an active goal, tells no one.
func TestAProposedGoalTellsTheOrchestratorWhenItBecomesActive(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	toldNew := func() int {
		t.Helper()
		h.WaitBackground()
		msgs, err := h.bs.ListMessages(ctx, "team", 100, 0, 0)
		require.NoError(t, err)
		n := 0
		for _, m := range msgs {
			if strings.Contains(m.Content, "new goal") {
				n++
			}
		}
		return n
	}
	code, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Maybe", "outcome": "o", "done_when": "d", "state": "proposed", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	id := itoa(int64(g["id"].(float64)))
	assert.Empty(t, g["orchestrator_told_at"])
	assert.Zero(t, toldNew(), "a proposed goal tells no one")

	code, _ = call("PATCH", "/api/board/team/goals/"+id, map[string]any{"outcome": "still proposed", "subscriber_id": "Operator"})
	require.Equal(t, 200, code)
	assert.Zero(t, toldNew())
	code, out := call("PATCH", "/api/board/team/goals/"+id, map[string]any{"state": "active", "subscriber_id": "Operator"})
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, 1, toldNew(), "active: the Orchestrator is told")
	assert.NotEmpty(t, out["orchestrator_told_at"])
	code, _ = call("PATCH", "/api/board/team/goals/"+id, map[string]any{"outcome": "changed again", "subscriber_id": "Operator"})
	require.Equal(t, 200, code)
	assert.Equal(t, 1, toldNew())

	// an active goal that has no told-at (made before this) is not told by an unrelated change
	old, err := h.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Old", Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	code, _ = call("PATCH", "/api/board/team/goals/"+itoa(old.ID), map[string]any{"outcome": "touched", "subscriber_id": "Operator"})
	require.Equal(t, 200, code)
	assert.Equal(t, 1, toldNew(), "no flood of old goals")
}

// #11887: a goal the team's Orchestrator wrote itself says so in the goal's own JSON (made_by_orchestrator), on the reply that made it, the goal read and the list; a goal anyone else made does not. The Orchestrator is
// told nothing about its own goal, so the page cannot say "nobody was told" there.
func TestAGoalTheOrchestratorMadeSaysSo(t *testing.T) {
	server, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	code, own := call("POST", "/api/board/team/goals", map[string]any{"title": "Mine", "outcome": "o", "done_when": "d", "subscriber_id": "Orchestrator"})
	require.Equal(t, http.StatusCreated, code, "%v", own)
	assert.Equal(t, true, own["made_by_orchestrator"], "the reply says so")
	assert.Empty(t, own["orchestrator_told_at"], "and nobody was told")
	code, other := call("POST", "/api/board/team/goals", map[string]any{"title": "Theirs", "outcome": "o", "done_when": "d", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", other)
	assert.Nil(t, other["made_by_orchestrator"], "a goal the Operator made does not say it")
	code, got := call("GET", "/api/board/team/goals/"+itoa(int64(own["id"].(float64))), nil)
	require.Equal(t, 200, code)
	assert.Equal(t, true, got["made_by_orchestrator"], "the goal read says so")
	code, list := call("GET", "/api/board/team/goals", nil)
	require.Equal(t, 200, code)
	made := map[string]any{}
	for _, it := range list["goals"].([]any) {
		m := it.(map[string]any)
		made[m["title"].(string)] = m["made_by_orchestrator"]
	}
	assert.Equal(t, true, made["Mine"], "the list says so")
	assert.Nil(t, made["Theirs"])
}
