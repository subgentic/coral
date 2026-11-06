package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13964: the Orchestrator's own model and thinking default go to the SEAT, never to a name that says "orchestrator". The seat is the member a team launch names as Orchestrator by the rule #13891 uses to
// seed the grant (the first member whose name claims the role), or, for a single launch, the one that would take the team's Orchestrator seat. A launch by an agent never gets it.

const (
	seatOrchModel   = "claude-opus-5-5"
	seatWorkerModel = "claude-sonnet-5-5"
)

func seatRig(t *testing.T) *orchRig {
	t.Helper()
	r := newOrchRig(t)
	ctx := context.Background()
	require.NoError(t, r.ss.SetSetting(ctx, "default_model_claude", seatWorkerModel))
	require.NoError(t, r.ss.SetSetting(ctx, "default_orchestrator_model_claude", seatOrchModel))
	return r
}

// modelsSince is the model each command sent since `before` was started on, in order.
func (r *orchRig) modelsSince(before int) []string {
	var out []string
	for _, c := range r.term.sentCommands()[before:] {
		switch {
		case strings.Contains(c, seatOrchModel):
			out = append(out, "orch")
		case strings.Contains(c, seatWorkerModel):
			out = append(out, "worker")
		default:
			out = append(out, "none")
		}
	}
	return out
}

func TestOnlyTheTeamsSeatGetsTheOrchestratorModelNotEveryNameThatSaysOrchestrator(t *testing.T) {
	r := seatRig(t)
	before := len(r.term.sentCommands())
	code, out := r.do("POST", "/api/sessions/launch-team", defTeamBody("seatteam", r.work, "Orchestrator helper", "Dev", "Orchestrator"), operatorClient, "")
	require.Equal(t, http.StatusOK, code, out)
	// the grant seed's rule: the FIRST member that claims the role is the seat; a later one is a worker
	assert.Equal(t, []string{"orch", "worker", "worker"}, r.modelsSince(before))
}

func TestAnAgentsTeamLaunchNeverGetsTheOrchestratorModel(t *testing.T) {
	r := seatRig(t)
	r.usualBoard()
	before := len(r.term.sentCommands())
	b, _ := json.Marshal(map[string]any{"board_id": orchBoard, "working_dir": r.work, "agent_type": "claude", "agents": []map[string]any{{"name": "Orchestrator", "prompt": "w"}, {"name": "Dev9", "prompt": "w"}}})
	code, out := r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok["Dev2"])
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, []string{"worker", "worker"}, r.modelsSince(before))
}

func TestASingleLaunchGetsTheOrchestratorModelOnlyWhereItTakesTheSeat(t *testing.T) {
	r := seatRig(t)
	launch := func(name, boardID string, client *http.Client, tok string) []string {
		before := len(r.term.sentCommands())
		body := map[string]any{"working_dir": r.work, "agent_type": "claude", "display_name": name}
		if boardID != "" {
			body["board_id"] = boardID
		}
		b, _ := json.Marshal(body)
		code, out := r.do("POST", "/api/sessions/launch", string(b), client, tok)
		require.Equal(t, http.StatusOK, code, out)
		return r.modelsSince(before)
	}
	assert.Equal(t, []string{"orch"}, launch("Orchestrator", "", operatorClient, ""), "the Operator's launch that would take the seat")
	r.usualBoard() // the team now has its Orchestrator
	assert.Equal(t, []string{"worker"}, launch("Orchestrator helper", orchBoard, operatorClient, ""), "a name that says orchestrator, on a team that has one, is a worker")
	assert.Equal(t, []string{"worker"}, launch("Dev9", orchBoard, operatorClient, ""))
	assert.Equal(t, []string{"worker"}, launch("Orchestrator", orchBoard, nil, r.tok["Dev2"]), "an agent never gets it")
	assert.Equal(t, []string{"worker"}, launch("Orchestrator helper", "", nil, r.tok["Dev2"]))
}

func TestTheThinkingLevelFollowsTheSameSeatAsTheModel(t *testing.T) {
	r := seatRig(t)
	ctx := context.Background()
	require.NoError(t, r.ss.SetSetting(ctx, "default_thinking_claude", "low"))
	require.NoError(t, r.ss.SetSetting(ctx, "default_orchestrator_thinking_claude", "high"))
	r.usualBoard()
	run := func(name, boardID string) string {
		before := len(r.term.sentCommands())
		body := `{"working_dir":"` + r.work + `","agent_type":"claude","display_name":"` + name + `"`
		if boardID != "" {
			body += `,"board_id":"` + boardID + `"`
		}
		code, out := r.do("POST", "/api/sessions/launch", body+"}", operatorClient, "")
		require.Equal(t, http.StatusOK, code, out)
		return strings.Join(r.term.sentCommands()[before:], "\n")
	}
	worker := run("Orchestrator helper", orchBoard)
	assert.Contains(t, worker, "low")
	assert.NotContains(t, worker, "high")
	assert.Contains(t, run("Orchestrator", ""), "high")
}

// A look-alike that already holds the seat stands in the way of the next one (QA's gap on #13964): the holder check is the board's, so it counts a holder by its name or title, whatever the case.
func TestASecondLookAlikeOnATeamWhoseSeatIsHeldByOneIsAWorker(t *testing.T) {
	r := seatRig(t)
	launch := func(name string) []string {
		before := len(r.term.sentCommands())
		b, _ := json.Marshal(map[string]any{"working_dir": r.work, "agent_type": "claude", "display_name": name, "board_id": orchBoard})
		code, out := r.do("POST", "/api/sessions/launch", string(b), operatorClient, "")
		require.Equal(t, http.StatusOK, code, out)
		return r.modelsSince(before)
	}
	// the team's only holder is a look-alike (no member named just Orchestrator)
	r.seat("Orchestrator helper", "Helper", orchBoard, "claude", false, 1)
	assert.Equal(t, []string{"worker"}, launch("Orchestrator helper two"), "the seat is held, by a look-alike")
	assert.Equal(t, []string{"worker"}, launch("ORCHESTRATOR backup"), "whatever the case")
	assert.Equal(t, []string{"worker"}, launch("Dev9"))
}
