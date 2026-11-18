package routes

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"sync/atomic"
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

// #19673: names are unique in a team, archived agents included.
func TestALaunchWithATeamMembersNameIsRefusedWithTheChoices(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	require.NoError(t, r.ss.SetSessionArchived(ctx, r.sid["Dev"], true))

	for _, name := range []string{"Dev", "dev", " DEV "} { // case and spacing do not make another name
		w := httptest.NewRecorder()
		assert.True(t, r.h.refuseMemberName(w, ctx, orchBoard, name, ""), name)
		assert.Equal(t, http.StatusConflict, w.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		assert.Equal(t, "name_archived", out["code"], name)
		assert.Equal(t, "Dev", out["member"])
		assert.Equal(t, r.sid["Dev"], out["session_id"], "Start it is the wake route on this session")
		assert.Equal(t, "Dev 2", out["suggested_name"])
	}

	w := httptest.NewRecorder() // an awake member's name is taken: its own refusal, not an upsert
	assert.True(t, r.h.refuseMemberName(w, ctx, orchBoard, "Dev2", ""))
	assert.Contains(t, w.Body.String(), "name_taken")

	w = httptest.NewRecorder() // the member asking from its own session is not in conflict with itself (a restart, its own Start)
	assert.False(t, r.h.refuseMemberName(w, ctx, orchBoard, "Dev", naming.SessionName("claude", r.sid["Dev"])))
	w = httptest.NewRecorder()
	assert.False(t, r.h.refuseMemberName(w, ctx, orchBoard, "Somebody New", ""))
	w = httptest.NewRecorder()
	assert.False(t, r.h.refuseMemberName(w, ctx, "another-team", "Dev", ""), "another team's name is another name")

	// the launch route itself
	code, out := r.do("POST", "/api/sessions/launch", `{"working_dir":"`+r.work+`","agent_type":"claude","display_name":"Dev","board_id":"`+orchBoard+`"}`, nil, r.tok["Orchestrator"])
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "name_archived", out["code"])
}

// launch-team keeps numbering a repeated name (Backend Dev 2); the number must count archived members too, so a team launch never reuses an archived member's name (#19684).
func TestATeamLaunchNeverReusesAnArchivedMembersName(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	require.NoError(t, r.ss.SetSessionArchived(ctx, r.sid["Dev"], true))
	b, _ := json.Marshal(map[string]any{"board_id": orchBoard, "working_dir": r.work, "agent_type": "claude", "agents": []map[string]any{{"name": "Dev", "prompt": "work"}}})
	code, out := r.do("POST", "/api/sessions/launch-team", string(b), operatorClient, "")
	require.Equal(t, http.StatusOK, code, "%v", out)
	agents, _ := out["agents"].([]any)
	require.Len(t, agents, 1)
	assert.Equal(t, "Dev 2", agents[0].(map[string]any)["name"], "the archived Dev keeps its name; the new member is numbered")
	ls, err := r.ss.GetLiveSession(ctx, r.sid["Dev"])
	require.NoError(t, err)
	require.NotNil(t, ls)
	assert.Equal(t, 1, ls.IsArchived, "the archived member is untouched")
}

var helperSeq atomic.Int64

// nextHelperName gives each launch in a test a name of its own: a team's names are unique, archived members included (#19673).
func nextHelperName() string { return fmt.Sprintf("Helper %d", helperSeq.Add(1)) }

// #19696: Start brings an Archived agent back Awake in one call, from the dashboard Start, the Orchestrator's wake and coral-board wake. An Archived agent is an archived row (asleep, flag set) or one that ended (its session is over, the row inactive); both start.
func (r *orchRig) end(member string) {
	r.t.Helper()
	_, err := r.h.db.ExecContext(context.Background(), `UPDATE live_sessions SET status = 'inactive', stopped_at = ?, is_sleeping = 0, is_archived = 0 WHERE session_id = ?`, time.Now().UTC().Format(time.RFC3339), r.sid[member])
	require.NoError(r.t, err)
}

func (r *orchRig) awake(member string) bool {
	r.t.Helper()
	ls, err := r.ss.GetLiveSession(context.Background(), r.sid[member])
	require.NoError(r.t, err)
	return ls != nil && ls.IsSleeping == 0 && ls.IsArchived == 0 && ls.Status == "active"
}

func (r *orchRig) dashboard(action, member string) (int, map[string]any) {
	return r.do("POST", "/api/sessions/live/"+r.sid[member]+"/"+action, "", operatorClient, "")
}

func TestStartBringsAnArchivedAgentBackAwakeFromEveryRoute(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"stop_enabled": true, "max_live": 20, "max_per_hour": 50})
	require.Equal(t, http.StatusOK, code)

	// the dashboard: Stop (archive) then Start
	code, out := r.dashboard("archive", "Dev2")
	require.Equal(t, http.StatusOK, code, "%v", out)
	require.True(t, r.archived("Dev2"))
	code, out = r.dashboard("wake", "Dev2")
	assert.Equal(t, true, out["ok"], "Archived -> Start: %v", out)
	assert.True(t, r.awake("Dev2"), "and it is Awake")

	// the Orchestrator: stop then wake
	code, out = r.agentPost("Orchestrator", "stop", "Dev2", "")
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = r.agentPost("Orchestrator", "wake", "Dev2", "")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.True(t, r.awake("Dev2"))

	// Archived -> Sleep -> Start
	code, out = r.dashboard("archive", "Dev2")
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = r.dashboard("sleep", "Dev2")
	assert.Equal(t, true, out["ok"], "%v", out)
	assert.True(t, r.asleep("Dev2"))
	assert.False(t, r.archived("Dev2"), "Sleep clears Archived")
	code, out = r.dashboard("wake", "Dev2")
	assert.Equal(t, true, out["ok"], "%v", out)
	assert.True(t, r.awake("Dev2"))

	// an agent whose session ended (a Stop that killed it, its own exit) is Archived too: Start brings it back from either route
	r.end("Dev2")
	code, out = r.dashboard("wake", "Dev2")
	assert.Equal(t, true, out["ok"], "an ended agent, dashboard Start: %v", out)
	assert.True(t, r.awake("Dev2"), "ended -> Awake")
	r.end("Dev2")
	code, out = r.agentPost("Orchestrator", "wake", "Dev2", "")
	assert.Equal(t, http.StatusOK, code, "an ended agent, the Orchestrator's wake: %v", out)
	assert.True(t, r.awake("Dev2"))
}
