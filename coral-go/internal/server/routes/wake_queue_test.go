package routes

import (
	"context"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #14133: the notice a woken agent gets names its own tasks, so a restarted agent with work in progress does not depend on remembering it (it had introduced itself and waited for the Orchestrator).

func wakeQueueRig(t *testing.T, team, name string) (*wakeRig, string, context.Context) {
	t.Helper()
	r := newWakeRig(t)
	ctx := context.Background()
	haveClaudeConversation(t, sid(1))
	r.add(sid(1), name, store.SleepReasonCoralStopped, "", false)
	_, err := r.h.db.ExecContext(ctx, "UPDATE live_sessions SET board_name = ? WHERE session_id = ?", team, sid(1))
	require.NoError(t, err)
	subID := naming.SubscriberID(name, "claude")
	_, err = r.h.bs.Subscribe(ctx, team, subID, name, naming.SessionName("claude", sid(1)), nil, "mentions")
	require.NoError(t, err)
	return r, subID, ctx
}

func TestAWakeNoticeNamesTheInProgressAndAssignedTasksAndNothingElse(t *testing.T) {
	const team = "team-14133"
	r, subID, ctx := wakeQueueRig(t, team, "Dev One")
	mk := func(title, prio, assignee string) int64 {
		tk, err := r.h.bs.CreateTask(ctx, team, title, "body", prio, "Orchestrator", assignee)
		require.NoError(t, err)
		return tk.ID
	}
	inProg := mk("SECRET-TITLE-A", "high", subID)
	_, err := r.h.bs.ClaimTask(ctx, team, subID, inProg)
	require.NoError(t, err)
	low := mk("SECRET-TITLE-B", "low", subID)
	crit := mk("SECRET-TITLE-C", "critical", subID)
	other := mk("someone else's", "high", "other-sub")
	done := mk("finished", "high", subID)
	_, err = r.h.bs.CancelTask(ctx, team, done, subID, nil)
	require.NoError(t, err)

	r.h.AutoWakeAfterRestart(ctx)

	msgs, err := r.h.bs.ListMessages(ctx, team, 50, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	c := msgs[0].Content
	assert.Contains(t, c, "@Dev One "+AutoWakeNotice, "the fixed sentence is still first")
	assert.Contains(t, c, "in progress #"+wqNum(inProg)+" (resume it from its thread and worktree)")
	assert.Contains(t, c, "assigned and waiting #"+wqNum(crit)+", #"+wqNum(low), "claim's order: priority, then id")
	assert.Contains(t, c, "coral-board task list --mine")
	assert.NotContains(t, c, "#"+wqNum(other), "another agent's task is not named")
	assert.NotContains(t, c, "#"+wqNum(done), "a cancelled task is not named")
	assert.NotContains(t, c, "SECRET-TITLE", "numbers only: no stored text in a Coral notice")
	assert.Equal(t, board.CoralSender, msgs[0].SubscriberID)
}

func TestAWakeNoticeOfAnAgentWithNoTasksIsTheFixedSentenceAlone(t *testing.T) {
	const team = "team-14133b"
	r, _, ctx := wakeQueueRig(t, team, "Dev Two")
	r.h.AutoWakeAfterRestart(ctx)
	msgs, err := r.h.bs.ListMessages(ctx, team, 50, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	assert.Equal(t, "@Dev Two "+AutoWakeNotice, msgs[0].Content)
}

func TestTheOrchestratorsWakeLineNamesTheWokenAgentsTasksToo(t *testing.T) {
	const team = "team-14133c"
	r, subID, ctx := wakeQueueRig(t, team, "Dev Three")
	tk, err := r.h.bs.CreateTask(ctx, team, "t", "b", "high", "Orchestrator", subID)
	require.NoError(t, err)
	r.h.tellWoken(ctx, team, "Dev Three")
	msgs, err := r.h.bs.ListMessages(ctx, team, 50, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0].Content, OrchestratorWakeNotice)
	assert.Contains(t, msgs[0].Content, "assigned and waiting #"+wqNum(tk.ID))
}

func wqNum(n int64) string { return strconv.FormatInt(n, 10) }
