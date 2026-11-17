package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #14050 (the Operator: "lets allow orchestrators to create goals by default"): the member in the team's Orchestrator SEAT (the session the board's grant names) plans the team's goals and tasks whatever its title says;
// the exact title and the launch record still do; a worker does not, nor a title that merely says orchestrator; and planning is all that widens.

const seatSession = "11111111-2222-3333-4444-555555555555"

func seatTeam(t *testing.T) (*BoardHandler, func(method, path string, body any) (int, map[string]any)) {
	t.Helper()
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	// "Team Lead": no word orchestrator anywhere, joined (no launch record), in the seat's session; "Dev": a worker
	_, err := h.bs.Subscribe(ctx, "team", "Lead", "Team Lead", "claude-"+seatSession, nil, "all", false)
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-aaaaaaaa-0000-0000-0000-000000000001", nil, "mentions", false)
	require.NoError(t, err)
	return h, goalCall(t, server.URL)
}

func TestTheOrchestratorSeatPlansGoalsAndTasksWhateverItsTitle(t *testing.T) {
	h, call := seatTeam(t)
	goal := func(who string) int {
		code, _ := call("POST", "/api/board/team/goals", map[string]any{"title": "A goal", "subscriber_id": who})
		return code
	}
	task := func(who string) int {
		code, _ := call("POST", "/api/board/team/tasks", map[string]any{"title": "A task", "subscriber_id": who})
		return code
	}
	// no seat yet: the Team Lead is a member like any other
	assert.Equal(t, http.StatusForbidden, goal("Lead"))
	assert.Equal(t, http.StatusForbidden, task("Lead"))
	// the grant names the seat (a team launch seeds it for the Orchestrator it starts; the Operator may choose another)
	ok, err := h.bs.SeedOrchGrant(context.Background(), "team", seatSession)
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, http.StatusCreated, goal("Lead"), "the seat creates a goal")
	assert.Equal(t, http.StatusCreated, task("Lead"), "and a shared task")
	// a worker is still refused
	assert.Equal(t, http.StatusForbidden, goal("Dev"))
	assert.Equal(t, http.StatusForbidden, task("Dev"))
	// the exact title still works, seat or not
	registerTaskPlanner(t, h, "team", "Orchestrator")
	assert.Equal(t, http.StatusCreated, goal("Orchestrator"))
}

func TestTheSeatChangesAndClosesGoalsAndLinksTasksToo(t *testing.T) {
	h, call := seatTeam(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	_, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Made by the Orchestrator", "subscriber_id": "Orchestrator"})
	id := int64(g["id"].(float64))
	_, err := h.bs.SeedOrchGrant(context.Background(), "team", seatSession)
	require.NoError(t, err)
	code, out := call("PATCH", "/api/board/team/goals/"+itoa(id), map[string]any{"title": "Changed by the seat", "subscriber_id": "Lead"})
	assert.Equal(t, http.StatusOK, code, out)
	code, out = call("PATCH", "/api/board/team/goals/"+itoa(id), map[string]any{"title": "Changed by a worker", "subscriber_id": "Dev"})
	assert.Equal(t, http.StatusForbidden, code, out)
	code, out = call("POST", "/api/board/team/goals/"+itoa(id)+"/close", map[string]any{"reason": "done", "subscriber_id": "Lead"})
	assert.Equal(t, http.StatusOK, code, out)
}

func TestTheSeatIsNotAWayToReviewOrCompleteForAnyoneElse(t *testing.T) {
	h, _ := seatTeam(t)
	ctx := context.Background()
	_, err := h.bs.SeedOrchGrant(ctx, "team", seatSession)
	require.NoError(t, err)
	assert.NoError(t, h.bs.RequirePlanner(ctx, "team", "Lead"), "the seat plans")
	assert.Error(t, h.bs.RequireTaskReviewer(ctx, "team", "Lead"), "reviews, completion reviews and the merge queue keep the old rule")
	assert.Error(t, h.bs.RequirePlanner(ctx, "team", "Dev"))
}

func TestOnlyTheTeamsOwnActiveSeatCounts(t *testing.T) {
	h, call := seatTeam(t)
	ctx := context.Background()
	// the same session is the seat of ANOTHER board: not this team's
	_, err := h.bs.Subscribe(ctx, "beta", "Boss", "Boss", "claude-bbbbbbbb-0000-0000-0000-000000000009", nil, "all", false)
	require.NoError(t, err)
	_, err = h.bs.SeedOrchGrant(ctx, "beta", seatSession)
	require.NoError(t, err)
	code, _ := call("POST", "/api/board/team/goals", map[string]any{"title": "A goal", "subscriber_id": "Lead"})
	assert.Equal(t, http.StatusForbidden, code, "another board's seat is no seat here")
	// a seat that names a session no member has plans for nobody
	_, err = h.bs.SeedOrchGrant(ctx, "team", "99999999-9999-9999-9999-999999999999")
	require.NoError(t, err)
	code, _ = call("POST", "/api/board/team/goals", map[string]any{"title": "A goal", "subscriber_id": "Lead"})
	assert.Equal(t, http.StatusForbidden, code)
	// the real seat, then the member leaves: an inactive member plans nothing
	require.NoError(t, h.bs.SetOrchGrant(ctx, board.OrchGrant{Project: "team", Enabled: true, SeatSession: seatSession, MaxPerHour: 5, MaxLive: 3, IdleMin: 5}, "Operator"))
	code, _ = call("POST", "/api/board/team/goals", map[string]any{"title": "A goal", "subscriber_id": "Lead"})
	assert.Equal(t, http.StatusCreated, code)
	_, err = h.bs.Unsubscribe(ctx, "team", "Lead")
	require.NoError(t, err)
	code, _ = call("POST", "/api/board/team/goals", map[string]any{"title": "Another", "subscriber_id": "Lead"})
	assert.Equal(t, http.StatusForbidden, code, "an inactive seat holder")
}

func TestATitleThatOnlySaysOrchestratorIsStillNoPrivilege(t *testing.T) {
	server, h := setupBoardTestServer(t)
	_, err := h.bs.Subscribe(context.Background(), "team", "Chief", "Chief Orchestrator", "claude-cccccccc-0000-0000-0000-000000000003", nil, "all", false) // joined: no launch record, not the exact title, no seat
	require.NoError(t, err)
	code, _ := goalCall(t, server.URL)("POST", "/api/board/team/goals", map[string]any{"title": "A goal", "subscriber_id": "Chief"})
	assert.Equal(t, http.StatusForbidden, code, "as before: a title is not the seat")
}

func TestARefusedGoalRequestSendNamesTheSeatToo(t *testing.T) {
	assert.Contains(t, goalRequestSendWords("team").notPlanner, "Orchestrator seat")
	assert.Contains(t, goalRequestSendWords("team").notPlanner, "job title must be the word Orchestrator")
}

// Security's SHOULD on #14050: the member's session IS the seat's, compared whole as "<agent type>-<seat id>": a name that merely ends in the seat id, or carries another prefix, is not the seat.
func TestOnlyTheSeatsExactSessionNameIsTheSeat(t *testing.T) {
	h, call := seatTeam(t)
	ctx := context.Background()
	_, err := h.bs.SeedOrchGrant(ctx, "team", seatSession)
	require.NoError(t, err)
	plans := func(sessionName string) bool {
		_, err := h.bs.Subscribe(ctx, "team", "Lead", "Team Lead", sessionName, nil, "all", false) // the same member, with another session name
		require.NoError(t, err)
		code, _ := call("POST", "/api/board/team/goals", map[string]any{"title": "A goal", "subscriber_id": "Lead"})
		return code == http.StatusCreated
	}
	assert.True(t, plans("claude-"+seatSession), "the seat's own session")
	assert.True(t, plans("codex-"+seatSession), "any of Coral's agent types")
	for _, name := range []string{
		"evil-" + seatSession,          // another prefix: the old suffix test and SessionIDFromName both said yes
		"claudex-" + seatSession,       // a prefix that only starts like a type
		"claude-x-" + seatSession,      // ends in the seat id
		seatSession,                    // no prefix at all
		"claude-" + seatSession + "-2", // the id is not the end
		"Claude-" + seatSession,        // not the type's spelling
		"claude-" + seatSession[1:],    // a different id
	} {
		assert.False(t, plans(name), "%q is not the seat's session", name)
	}
}

// QA's SHOULD on #14050: isTaskPlanner (the planner-or-assignee edits: cancel, nudge, reminders, release, and the task title and priority edit through requireTaskTextEditor) is the seat's too. Changing it back to the old
// rule would leave a seat holder with another title unable to cancel or edit the team's shared tasks, with nothing else noticing.
func TestTheSeatCancelsAndEditsSharedTasksAndAWorkerCannot(t *testing.T) {
	h, call := seatTeam(t)
	ctx := context.Background()
	_, err := h.bs.SeedOrchGrant(ctx, "team", seatSession)
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Dev2", "Developer", "claude-aaaaaaaa-0000-0000-0000-000000000002", nil, "mentions", false)
	require.NoError(t, err)
	mk := func() int64 { // a shared task assigned to Dev2: neither Lead nor Dev made or owns it
		tk, err := h.bs.CreateTask(ctx, "team", "Shared task", "", "medium", "Orchestrator")
		require.NoError(t, err)
		_, err = h.bs.ClaimTask(ctx, "team", "Dev2", tk.ID)
		require.NoError(t, err)
		return tk.ID
	}
	// the helper the edits use, directly: the Operator, the seat, not a worker, nobody
	assert.True(t, h.isTaskPlanner(ctx, "team", "Operator"))
	assert.True(t, h.isTaskPlanner(ctx, "team", "Lead"), "the seat plans the team's shared tasks, whatever its title")
	assert.False(t, h.isTaskPlanner(ctx, "team", "Dev"))
	assert.False(t, h.isTaskPlanner(ctx, "team", ""))
	// cancel (requirePlannerOrAssignee): a worker that is not the assignee is refused, the seat is not
	id := mk()
	code, out := call("POST", "/api/board/team/tasks/"+itoa(id)+"/cancel", map[string]any{"subscriber_id": "Dev", "message": "no"})
	assert.Equal(t, http.StatusForbidden, code, out)
	code, out = call("POST", "/api/board/team/tasks/"+itoa(id)+"/cancel", map[string]any{"subscriber_id": "Lead", "message": "the seat cancels it"})
	assert.Equal(t, http.StatusOK, code, out)
	// the title/priority editor shares the helper
	task, err := h.bs.GetTask(ctx, "team", mk())
	require.NoError(t, err)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/x", nil)
	assert.True(t, h.requireTaskTextEditor(rec, req, "team", task, "Lead"), "the seat edits a shared task's title")
	rec = httptest.NewRecorder()
	assert.False(t, h.requireTaskTextEditor(rec, req, "team", task, "Dev"), "a worker does not")
	assert.Equal(t, http.StatusForbidden, rec.Code)
}
