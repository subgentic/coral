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
	// #19507 (the Operator, 2026-11-18; it replaces #19138's "no row is off"): a team whose switch was never touched has it ON for its one Orchestrator seat, and OFF where no member is titled Orchestrator.
	t.Run("never decided, one Orchestrator seat: an agent's launch works", func(t *testing.T) {
		r := setup(t, nil)
		status, out := launch(r, r.tok["Orchestrator"], nil)
		assert.Equal(t, http.StatusOK, status, "%v", out)
	})
	t.Run("never decided, no member titled Orchestrator: an agent's launch is refused, with where to turn it on", func(t *testing.T) {
		r := newOrchRig(t)
		r.seat("Orchestrator", "Lead", orchBoard, "claude", false, 1)
		r.seat("Dev2", "Developer", orchBoard, "claude", false, 3)
		before := len(r.term.sentCommands())
		status, out := launch(r, r.tok["Orchestrator"], nil)
		assert.Equal(t, http.StatusForbidden, status, "%v", out)
		assert.Equal(t, "orchestrator_access_off", out["code"])
		assert.Contains(t, out["error"], "Orchestrator access")
		assert.Len(t, r.term.sentCommands(), before)
	})
	t.Run("never decided: the Operator's launch is unchanged", func(t *testing.T) {
		r := setup(t, nil)
		status, out := launch(r, "", nil)
		assert.Equal(t, http.StatusOK, status, "%v", out)
	})
}

func toStr(v any) string { s, _ := v.(string); return s }
