package routes

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17661: with the Operator's Orchestrator access OFF for a team, an agent's launch is refused with the way forward; the Operator's own launch, a team with the access ON is unchanged; a board the Operator never decided for is refused like an off one (#19138).
func TestAnAgentsLaunchIsRefusedWhileTheTeamsOrchestratorAccessIsOff(t *testing.T) {
	launch := func(r *orchRig, tok string, extra map[string]any) (int, map[string]any) {
		req := map[string]any{"working_dir": r.work, "agent_type": "claude", "display_name": "Reviewer", "prompt": "Review.", "board_id": orchBoard}
		for k, v := range extra {
			req[k] = v
		}
		b, _ := json.Marshal(req)
		if tok == "" {
			return r.do("POST", "/api/sessions/launch", string(b), operatorClient, "")
		}
		return r.do("POST", "/api/sessions/launch", string(b), nil, tok)
	}
	setup := func(t *testing.T, enabled *bool) *orchRig {
		r := newOrchRig(t)
		r.usualBoard()
		if enabled != nil {
			code, _ := r.operatorGrant("Orchestrator", nil)
			require.Equal(t, http.StatusOK, code)
			if !*enabled {
				b, _ := json.Marshal(map[string]any{"enabled": false})
				code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", string(b), operatorClient, "")
				require.Equal(t, http.StatusOK, code)
			}
		}
		return r
	}
	on, off := true, false
	t.Run("off: an agent's launch is refused and nothing starts", func(t *testing.T) {
		r := setup(t, &off)
		before := len(r.term.sentCommands())
		status, out := launch(r, r.tok["Orchestrator"], nil)
		assert.Equal(t, http.StatusForbidden, status, "%v", out)
		assert.Equal(t, "orchestrator_access_off", out["code"])
		assert.Contains(t, out["error"], "ask the Operator to turn on Orchestrator access")
		assert.Len(t, r.term.sentCommands(), before)
	})
	t.Run("off: a launch naming no board is refused too", func(t *testing.T) {
		r := setup(t, &off)
		status, out := launch(r, r.tok["Orchestrator"], map[string]any{"board_id": ""})
		assert.Equal(t, http.StatusForbidden, status, "%v", out)
	})
	t.Run("off: a team launch by an agent is refused", func(t *testing.T) {
		r := setup(t, &off)
		b, _ := json.Marshal(map[string]any{"board_id": orchBoard, "working_dir": r.work, "agents": []map[string]any{{"name": "Reviewer", "agent_type": "claude", "prompt": "Review."}}})
		status, out := r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok["Orchestrator"])
		assert.Equal(t, http.StatusForbidden, status, "%v", out)
		assert.Equal(t, "orchestrator_access_off", out["code"])
	})
	t.Run("off: the Operator's launch is unchanged", func(t *testing.T) {
		r := setup(t, &off)
		status, out := launch(r, "", nil)
		assert.Equal(t, http.StatusOK, status, "%v", out)
	})
	t.Run("on: an agent's launch works", func(t *testing.T) {
		r := setup(t, &on)
		status, out := launch(r, r.tok["Orchestrator"], nil)
		assert.Equal(t, http.StatusOK, status, "%v", out)
	})
	// #19138 (the Operator): an Orchestrator started agents on a team whose switch they had never touched, while wake refused. No grant row is off, the way wake and restart read it.
	t.Run("never decided: an agent's launch is refused, with where to turn it on", func(t *testing.T) {
		r := setup(t, nil)
		before := len(r.term.sentCommands())
		status, out := launch(r, r.tok["Orchestrator"], nil)
		assert.Equal(t, http.StatusForbidden, status, "%v", out)
		assert.Equal(t, "orchestrator_access_off", out["code"])
		assert.Contains(t, out["error"], "Orchestrator access")
		assert.Contains(t, out["error"], orchBoard, "it names the team")
		assert.Len(t, r.term.sentCommands(), before)
		status, out = launch(r, r.tok["Orchestrator"], map[string]any{"board_id": ""})
		assert.Equal(t, http.StatusForbidden, status, "a launch naming no board, from an agent seated on the team: %v", out)
	})
	t.Run("never decided: a team launch by an agent is refused", func(t *testing.T) {
		r := setup(t, nil)
		b, _ := json.Marshal(map[string]any{"board_id": orchBoard, "working_dir": r.work, "agents": []map[string]any{{"name": "Reviewer", "agent_type": "claude", "prompt": "Review."}}})
		status, out := r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok["Orchestrator"])
		assert.Equal(t, http.StatusForbidden, status, "%v", out)
		assert.Equal(t, "orchestrator_access_off", out["code"])
	})
	t.Run("never decided: the Operator's launch is unchanged", func(t *testing.T) {
		r := setup(t, nil)
		status, out := launch(r, "", nil)
		assert.Equal(t, http.StatusOK, status, "%v", out)
	})
}

func toStr(v any) string { s, _ := v.(string); return s }
