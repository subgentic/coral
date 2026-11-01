package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptymanager"
)

// #11881 (QA's SHOULDs on #11866): the three ways the Orchestrator is told of a goal that the first tests did not pin.

// orchSession is an agent session name (<type>-<id>), the only kind a board notice is typed into.
const orchSession = "claude-00000000-0000-4000-8000-0000000000a1"

// toldNewGoal is the board messages that say a new goal was made.
func toldNewGoal(t *testing.T, h *BoardHandler, project string) []string {
	t.Helper()
	h.WaitBackground()
	msgs, err := h.bs.ListMessages(context.Background(), project, 100, 0, 0)
	require.NoError(t, err)
	var out []string
	for _, m := range msgs {
		if strings.Contains(m.Content, "new goal") {
			out = append(out, m.Content)
		}
	}
	return out
}

// An approved proposal makes the goal: the Orchestrator is told then (removing the call from ApproveProposal fails this), once, with the time kept.
func TestAnApprovedGoalProposalTellsTheOrchestrator(t *testing.T) {
	e := newProposalEnv(t)
	e.settings(t, board.BoardSettingsUpdate{GoalsNeedApproval: boolp(true)})
	code, out := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "Ship the beta", "outcome": "People use it", "subscriber_id": "Orchestrator"})
	require.Equal(t, http.StatusAccepted, code, out)
	id := int64(out["proposal_id"].(float64))
	assert.Empty(t, toldNewGoal(t, e.h, "team"), "a proposal is not a goal: nobody is told of a goal yet")

	code, ok := e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(id)+"/approve", nil)
	require.Equal(t, http.StatusOK, code, ok)
	msgs := toldNewGoal(t, e.h, "team")
	require.Len(t, msgs, 1, "%v", msgs)
	assert.Contains(t, msgs[0], "@Orchestrator")
	assert.Contains(t, msgs[0], "Ship the beta")
	goals := e.goals(t)
	require.Len(t, goals, 1)
	assert.NotEmpty(t, goals[0]["orchestrator_told_at"], "the goal keeps when it was told")

	code, _ = e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(id)+"/approve", nil)
	assert.Equal(t, http.StatusConflict, code)
	assert.Len(t, toldNewGoal(t, e.h, "team"), 1, "a second Approve tells no one again")
}

// A busy Orchestrator (a task in progress) is not interrupted: the message is there for it without the mention, and nothing is typed.
func TestABusyOrchestratorIsToldWithoutAMentionAndNotNudged(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", orchSession, nil, "all")
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, "team", "Busy work", "", "medium", "Operator", "Orchestrator")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "team", "Orchestrator", task.ID)
	require.NoError(t, err)
	busy, err := h.bs.HasActiveTaskForAssignee(ctx, "team", "Orchestrator", 0)
	require.NoError(t, err)
	require.True(t, busy, "the Orchestrator has a task in progress")
	terminal := newMockTerminal()
	terminal.sessions[orchSession] = &ptymanager.PaneInfo{SessionName: orchSession, Target: orchSession, CurrentPath: "/tmp"}
	h.SetTerminal(terminal)
	t.Cleanup(func() { ptymanager.ForgetSession(orchSession) })

	code, g := goalCall(t, server.URL)("POST", "/api/board/team/goals", map[string]any{"title": "While busy", "outcome": "o", "done_when": "d", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	msgs := toldNewGoal(t, h, "team")
	require.Len(t, msgs, 1, "%v", msgs)
	assert.NotContains(t, msgs[0], "@Orchestrator", "no mention: it waits for them")
	assert.Contains(t, msgs[0], "busy")
	assert.Contains(t, msgs[0], "coral-board goal show "+itoa(int64(g["id"].(float64))))
	assert.NotEmpty(t, g["orchestrator_told_at"], "told, as far as the goal's page goes: the message is on the board")
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	assert.Empty(t, terminal.sent, "nothing was typed into the busy Orchestrator")
}

// An idle Orchestrator with a running session gets the typed nudge: the fixed words and the number, nothing of the goal's text.
func TestTheTypedNudgeReachesAnIdleOrchestrator(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", orchSession, nil, "all")
	require.NoError(t, err)
	terminal := newMockTerminal()
	terminal.sessions[orchSession] = &ptymanager.PaneInfo{SessionName: orchSession, Target: orchSession, CurrentPath: "/tmp"}
	h.SetTerminal(terminal)
	t.Cleanup(func() { ptymanager.ForgetSession(orchSession) })

	code, g := goalCall(t, server.URL)("POST", "/api/board/team/goals", map[string]any{"title": "SECRET GOAL TITLE", "outcome": "SECRET OUTCOME", "done_when": "d", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	id := int64(g["id"].(float64))
	h.WaitBackground()
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	require.Len(t, terminal.sent[orchSession], 1, "one nudge: %v", terminal.sent)
	assert.Equal(t, typedNewGoalNudge(id), terminal.sent[orchSession][0])
	assert.NotContains(t, terminal.sent[orchSession][0], "SECRET")
}
