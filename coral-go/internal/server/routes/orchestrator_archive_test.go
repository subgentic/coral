package routes

import (
	"time"

	"context"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19673: a team agent is Awake, Asleep or Archived. The Orchestrator's stop archives (behind the grant's stop switch); wake and sleep bring an archived agent back.

func (r *orchRig) archived(member string) bool {
	ls, err := r.ss.GetLiveSession(context.Background(), r.sid[member])
	require.NoError(r.t, err)
	return ls.IsArchived == 1
}

func TestStopArchivesAWorkingAgentAndKeepsItsSeat(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil) // the orchestrator switch on, the stop switch not
	require.Equal(t, http.StatusOK, code)
	code, out := r.agentPost("Orchestrator", "stop", "Dev2", "")
	assert.Equal(t, http.StatusForbidden, code, "the stop switch is off by default: %v", out)
	assert.Equal(t, "stop_not_enabled", out["code"])
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"stop_enabled": true})
	require.Equal(t, http.StatusOK, code)

	code, out = r.agentPost("Orchestrator", "stop", "Dev2", "") // awake: its session ends
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["archived"])
	assert.True(t, r.asleep("Dev2"), "its session ended")
	assert.True(t, r.archived("Dev2"))
	sub, err := r.h.bs.GetProjectSubscription(context.Background(), orchBoard, "Dev2")
	require.NoError(t, err)
	assert.NotNil(t, sub, "it stays with the team")

	code, out = r.agentPost("Orchestrator", "stop", "Dev", "") // asleep: Sleeping -> Stop -> Archived
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.True(t, r.archived("Dev"))

	code, out = r.agentPost("Orchestrator", "stop", "Dev", "") // twice: a plain sentence
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["stopped"])
	assert.Contains(t, out["note"], "already archived")

	code, out = r.agentPost("Orchestrator", "stop", "Orchestrator", "")
	assert.Equal(t, "not_itself", out["code"], "%d", code)
}

func TestWakeAndSleepBringAnArchivedAgentBack(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"stop_enabled": true})
	require.Equal(t, http.StatusOK, code)
	for _, who := range []string{"Dev", "Dev2"} {
		code, out := r.agentPost("Orchestrator", "stop", who, "")
		require.Equal(t, http.StatusOK, code, "%v", out)
	}
	code, out := r.agentPost("Orchestrator", "sleep", "Dev", "") // Archived -> Sleep -> Sleeping
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.False(t, r.archived("Dev"))
	assert.True(t, r.asleep("Dev"))

	code, out = r.agentPost("Orchestrator", "wake", "Dev2", "") // Archived -> Start -> Awake
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.False(t, r.archived("Dev2"))
	assert.False(t, r.asleep("Dev2"))
}

func TestTheLastOrchestratorIsNeverArchived(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	ctx := context.Background()
	ls, err := r.ss.GetLiveSession(ctx, r.sid["Orchestrator"])
	require.NoError(t, err)
	code, why := r.h.archiveRefusal(ctx, ls)
	assert.Equal(t, "last_orchestrator", code, why)

	r.seat("Orch2", "Orchestrator", orchBoard, "claude", false, 4)
	code, _ = r.h.archiveRefusal(ctx, ls)
	assert.Equal(t, "", code, "another Orchestrator stays")
	dev, _ := r.ss.GetLiveSession(ctx, r.sid["Dev2"])
	code, _ = r.h.archiveRefusal(ctx, dev)
	assert.Equal(t, "", code, "a worker may always be archived")

	require.NoError(t, r.ss.SetSessionArchived(ctx, r.sid["Orch2"], true))
	code, _ = r.h.archiveRefusal(ctx, ls)
	assert.Equal(t, "last_orchestrator", code, "an archived Orchestrator does not count")
}

// QA5 on #19675: a stop must not archive an agent that waits on a person (an open wait, an open ask to the Operator), since archiving hides the question; once it is answered the stop goes through.
func TestStopRefusesAnAgentThatWaitsOnThePerson(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"stop_enabled": true})
	require.Equal(t, http.StatusOK, code)

	_, err := r.h.bs.RegisterWait(ctx, orchBoard, "Dev2", naming.SessionName("claude", r.sid["Dev2"]), board.WaitOperator, "", "may I delete it?", time.Hour)
	require.NoError(t, err)
	code, out := r.agentPost("Orchestrator", "stop", "Dev2", "")
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "waiting_for_the_person", out["code"])
	assert.False(t, r.archived("Dev2"), "nothing was archived")
	assert.False(t, r.asleep("Dev2"), "and its session was not ended")
	require.NoError(t, r.h.bs.CancelActiveWait(ctx, orchBoard, "Dev2"))

	q, err := r.h.bs.PostMessage(ctx, orchBoard, "Dev2", "@Operator which one?", nil)
	require.NoError(t, err)
	_, err = r.h.bs.Subscribe(ctx, orchBoard, "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	require.NoError(t, r.h.bs.RecordAsk(ctx, orchBoard, q, []string{"Operator"}))
	code, out = r.agentPost("Orchestrator", "stop", "Dev2", "")
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "waiting_for_the_person", out["code"])
	assert.False(t, r.archived("Dev2"))
}
