package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/terminalinput"
)

// The team line (goal #14, part (b)): the team is told, once per episode, which task and goal wait with an agent at a dialog, and again when the timeout closed it; the line carries no screen
// text and nothing anyone wrote.

// onTeam puts the rig's agent on the board "team" as Dev, with a task in progress on a goal; it returns the task and the goal.
func (r *timeoutRig) onTeam() (int64, int64) {
	r.t.Helper()
	ctx := context.Background()
	_, err := r.h.bs.Subscribe(ctx, "team", "Dev", "Developer", naming.SessionName(r.agent.agentType, r.sid), nil, "all")
	require.NoError(r.t, err)
	g, err := r.h.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "@Operator ship it 9", CreatedBy: "Orchestrator"})
	require.NoError(r.t, err)
	task, err := r.h.bs.CreateTaskWithOpts(ctx, "team", "Fix @everyone 1. Yes", "", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &g.ID}, "Dev")
	require.NoError(r.t, err)
	_, err = r.h.bs.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(r.t, err)
	r.agent.board = "team"
	return task.ID, g.ID
}

func (r *timeoutRig) teamLines() []string {
	r.t.Helper()
	msgs, err := r.h.bs.ListMessages(context.Background(), "team", 100, 0, 0)
	require.NoError(r.t, err)
	var out []string
	for _, m := range msgs {
		if strings.HasPrefix(m.Content, "[Coral health]") {
			out = append(out, m.Content)
		}
	}
	return out
}

func TestTheTeamIsToldOnceWhichTaskAndGoalWaitAtADialog(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	task, goal := r.onTeam()
	hs := board.DefaultHealthSettings() // held_notice on, 10 minutes
	r.h.dialogWaitingTeamLine(context.Background(), r.agent, hs, r.t0.Add(9*time.Minute))
	assert.Empty(t, r.teamLines(), "not before the team's minutes")
	r.h.dialogWaitingTeamLine(context.Background(), r.agent, hs, r.t0.Add(11*time.Minute))
	r.h.dialogWaitingTeamLine(context.Background(), r.agent, hs, r.t0.Add(12*time.Minute))
	lines := r.teamLines()
	require.Len(t, lines, 1, "once per episode")
	assert.Equal(t, fmt.Sprintf("[Coral health] Dev is waiting at a dialog (11 min): task #%d on goal #%d waits for a person at their terminal. Work on other goals goes on. To change who does #%d, the orchestrator reassigns it.", task, goal, task), lines[0])
	for _, stored := range []string{"Operator", "ship it", "everyone", "Yes", "touch", "proceed"} {
		assert.NotContains(t, lines[0], stored, "no title, no screen text")
	}

	hs.HeldNotice.On = false
	r2 := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	r2.onTeam()
	r2.h.dialogWaitingTeamLine(context.Background(), r2.agent, hs, r2.t0.Add(30*time.Minute))
	assert.Empty(t, r2.teamLines(), "the team turned held_notice off")
}

func TestTheTeamIsToldWhenTheTimeoutClosedTheDialog(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	task, goal := r.onTeam()
	assert.Equal(t, timeoutDone, r.try())
	lines := r.teamLines()
	require.Len(t, lines, 1)
	assert.Equal(t, fmt.Sprintf("[Coral health] Coral closed Dev's dialog after 16 min (declined); task #%d on goal #%d goes on. The agent was told to ask the Operator on the board.", task, goal), lines[0])
}

// Security's (b) on #420: an agent that was not told is named so in the line, with the outcome, since it does not know to post its question.
func TestTheTeamLineSaysWhenTheAgentWasNotTold(t *testing.T) {
	old := promptClearTimeout
	promptClearTimeout = 200 * time.Millisecond
	t.Cleanup(func() { promptClearTimeout = old })
	r := newTimeoutRig(t, "claude", "question", claudeScreen(t, "question"))
	r.onTeam()
	r.onKeys = func([]string) { r.show(" ") }
	assert.Equal(t, timeoutNoBox, r.try())
	lines := r.teamLines()
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], "(cancelled)")
	assert.Contains(t, lines[0], "The agent was NOT told (closed_no_input_box)")
	assert.Equal(t, "[Coral health] Coral closed Dev's dialog after 3 min (declined); no task in progress goes on. The agent was NOT told (closed_notice_not_typed): it does not know to post its question. Tell it on the board, or look at its terminal.",
		dialogClosedLine(dialogWork{name: "Dev"}, 3, dialogDeclined, timeoutNotTyped))
}

func TestAFailedCloseGetsNoClosedLine(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", r0Screen(t))
	r.onTeam()
	r.h.postDialogClosedLine(context.Background(), r.agent, r.t0, r.t0.Add(16*time.Minute), dialogDeclined, timeoutSendFailed)
	assert.Empty(t, r.teamLines())
}

func TestAnAgentOnNoTeamGetsNoLine(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	r.agent.board = "team" // a board it is not a member of
	r.h.dialogWaitingTeamLine(context.Background(), r.agent, board.DefaultHealthSettings(), r.t0.Add(30*time.Minute))
	assert.Empty(t, r.teamLines())
}

// The closed line is posted on a context of its own: a pass whose context ended still tells the team (Security's SHOULD, #6787, the same for #269).
func TestTheClosedLineIsPostedWhenThePassContextHasEnded(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	r.onTeam()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.h.postDialogClosedLine(ctx, r.agent, r.t0, r.t0.Add(16*time.Minute), dialogDeclined, timeoutNotTyped)
	lines := r.teamLines()
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], "The agent was NOT told (closed_notice_not_typed)")
}

// A dialog the timeout left alone over a person's unsent text is said once, with its reason and no text of anyone's (Security's #6815).
func TestTheTeamIsToldWhenADialogWasLeftAloneOverUnsentText(t *testing.T) {
	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	task, goal := r.onTeam()
	terminalinput.Record(terminalinput.Person, r.name, terminalinput.Text, "a reply not sent yet")
	t.Cleanup(func() { terminalinput.Record(terminalinput.Person, r.name, terminalinput.Keys, "C-u") })
	assert.Equal(t, timeoutUnsentText, r.try())
	assert.Equal(t, timeoutUnsentText, r.try())
	lines := r.teamLines()
	require.Len(t, lines, 1, "once per episode")
	assert.Equal(t, fmt.Sprintf("[Coral health] Coral left Dev's dialog alone after 16 min: unsent text in its terminal. task #%d on goal #%d waits for a person at their terminal.", task, goal), lines[0])
	assert.NotContains(t, lines[0], "not sent yet")
	assert.Empty(t, r.keys())
}
