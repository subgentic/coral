package routes

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #15112: the Orchestrator restarts an agent of its board as a fresh session, under the Operator's grant.

func (r *orchRig) liveSessionIDs() map[string]bool {
	r.t.Helper()
	rows, err := r.ss.GetBoardSessions(context.Background(), orchBoard)
	require.NoError(r.t, err)
	out := map[string]bool{}
	for _, s := range rows {
		if s.IsArchived == 0 {
			out[s.SessionID] = true
		}
	}
	return out
}

func TestTheOrchestratorRestartsAnIdleAgentUnderTheGrant(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	old := r.sid["Dev2"]

	code, out := r.agentPost("Orchestrator", "restart", "Dev2", "")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "Dev2", out["restarted"])
	ids := r.liveSessionIDs()
	assert.False(t, ids[old], "the old session is replaced")
	sub, err := r.h.bs.GetProjectSubscription(context.Background(), orchBoard, "Dev2")
	require.NoError(t, err)
	assert.NotContains(t, sub.SessionName, old, "its seat follows the new session")
	assert.Equal(t, "Developer", sub.JobTitle, "its job title is kept")

	msgs, err := r.h.bs.ListMessages(context.Background(), orchBoard, 50, 0, 0)
	require.NoError(t, err)
	var said bool
	for _, m := range msgs {
		if m.Content == "[Coral] Orchestrator restarted Dev2" {
			said = true
		}
	}
	assert.True(t, said, "the board says who restarted whom")
}

func TestARestartIsRefusedWithoutTheGrantForANonOrchestratorAndForAnotherBoardsMember(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	other := r.seat("Elsewhere", "Developer", "other-board", "claude", false, 4)
	old := r.sid["Dev2"]

	// the switch is off
	code, out := r.agentPost("Orchestrator", "restart", "Dev2", "")
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "orchestrator_switch_off", out["code"])
	assert.True(t, r.liveSessionIDs()[old], "nothing was restarted")

	code, _ = r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	// an agent that is not the seat
	code, out = r.agentPost("Dev2", "restart", "Dev", "")
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "not_the_seat", out["code"])
	// the seat itself
	code, out = r.agentPost("Orchestrator", "restart", "Orchestrator", "")
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "not_itself", out["code"])
	// a member of another board
	code, out = r.agentPost("Orchestrator", "restart", "Elsewhere", "")
	assert.Equal(t, http.StatusNotFound, code, "%v", out)
	ls, err := r.ss.GetLiveSession(context.Background(), other)
	require.NoError(t, err)
	assert.Equal(t, 0, ls.IsArchived, "the other board's agent is untouched")
	// no identity at all
	code, _ = r.do("POST", "/api/board/"+orchBoard+"/agents/Dev2/restart", "", nil, "")
	assert.GreaterOrEqual(t, code, 400)
	assert.True(t, r.liveSessionIDs()[old], "still the same session")
}

func TestARestartRefusesAnAgentInTheMiddleOfATurnUnlessItWaitsForIdle(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	old := restartIdleEvery
	restartIdleEvery = 20 * time.Millisecond
	t.Cleanup(func() { restartIdleEvery = old })

	d := r.sid["Dev2"]
	bash := "Bash"
	_, err := r.h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "Dev2", SessionID: &d, EventType: "tool_use", ToolName: &bash, Summary: "Bash", RefID: &bash, CreatedAt: time.Now().UTC().Add(-30 * time.Second).Format(store.ISOFormat)})
	require.NoError(t, err)
	code, out := r.agentPost("Orchestrator", "restart", "Dev2", "")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "working", out["code"])
	assert.True(t, r.liveSessionIDs()[d], "a working agent is not restarted")

	// when_idle: queued; once its turn ends (a stop event) it is restarted
	code, out = r.do("POST", "/api/board/"+orchBoard+"/agents/Dev2/restart?when_idle=1", "", nil, r.tok["Orchestrator"])
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "Dev2", out["queued"])
	code, out = r.do("POST", "/api/board/"+orchBoard+"/agents/Dev2/restart?when_idle=1", "", nil, r.tok["Orchestrator"])
	assert.Equal(t, http.StatusConflict, code, "one queued restart per agent")
	assert.Equal(t, "already_queued", out["code"])
	assert.True(t, r.liveSessionIDs()[d], "still waiting")
	stop := "stop"
	_, err = r.h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "Dev2", SessionID: &d, EventType: "stop", Summary: stop, CreatedAt: time.Now().UTC().Format(store.ISOFormat)})
	require.NoError(t, err)
	require.Eventually(t, func() bool { return !r.liveSessionIDs()[d] }, 5*time.Second, 20*time.Millisecond, "restarted at its next idle")
}

func TestARestartCountsTowardTheHoursCapWithWake(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 1})
	require.Equal(t, http.StatusOK, code)
	code, out := r.agentPost("Orchestrator", "restart", "Dev2", "")
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = r.agentPost("Orchestrator", "wake", "Dev", "")
	assert.Equal(t, http.StatusTooManyRequests, code, "the hour's cap is shared: %v", out)
}
