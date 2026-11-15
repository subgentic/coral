package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #17545: an Orchestrator that launches an agent naming no model starts it on the team's model (the seat's own), not on the Settings default: a Haiku team got a Sonnet member.
func TestAnOrchestratorsLaunchWithNoModelUsesTheTeamsModel(t *testing.T) {
	launch := func(t *testing.T, mutate func(map[string]any), setup func(r *orchRig)) string {
		r := newOrchRig(t)
		r.usualBoard()
		code, _ := r.operatorGrant("Orchestrator", nil)
		require.Equal(t, http.StatusOK, code)
		haiku := "haiku"
		sid := r.sid["Orchestrator"]
		bn := orchBoard
		require.NoError(t, r.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Orchestrator", WorkingDir: r.work, BoardName: &bn, Model: &haiku}))
		if setup != nil {
			setup(r)
		}
		req := map[string]any{"working_dir": r.work, "agent_type": "claude", "display_name": "Reviewer", "prompt": "Review.", "board_id": orchBoard}
		if mutate != nil {
			mutate(req)
		}
		body, _ := json.Marshal(req)
		before := len(r.term.sentCommands())
		status, out := r.do("POST", "/api/sessions/launch", string(body), nil, r.tok["Orchestrator"])
		require.Equal(t, http.StatusOK, status, "%v", out)
		return strings.Join(r.term.sentCommands()[before:], "\n")
	}
	t.Run("no model named: the team's", func(t *testing.T) {
		assert.Contains(t, launch(t, nil, nil), "--model haiku")
	})
	t.Run("a launch naming no board joins the team and takes its model", func(t *testing.T) {
		assert.Contains(t, launch(t, func(m map[string]any) { delete(m, "board_id") }, nil), "--model haiku")
	})
	t.Run("a model the caller names wins", func(t *testing.T) {
		out := launch(t, func(m map[string]any) { m["model"] = "sonnet" }, nil)
		assert.Contains(t, out, "--model sonnet")
		assert.NotContains(t, out, "--model haiku")
	})
	t.Run("a model in the flags wins", func(t *testing.T) {
		out := launch(t, func(m map[string]any) { m["flags"] = []string{"--model", "sonnet"} }, nil)
		assert.NotContains(t, out, "--model haiku")
	})
	t.Run("another agent type, another board or another computer is not given the seat's model", func(t *testing.T) {
		r := newOrchRig(t)
		r.usualBoard()
		code, _ := r.operatorGrant("Orchestrator", nil)
		require.Equal(t, http.StatusOK, code)
		haiku := "haiku"
		bn := orchBoard
		require.NoError(t, r.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: r.sid["Orchestrator"], AgentType: "claude", AgentName: "Orchestrator", WorkingDir: r.work, BoardName: &bn, Model: &haiku}))
		req := httptest.NewRequest("POST", "/api/sessions/launch", nil)
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: r.sid["Orchestrator"]}))
		assert.Equal(t, "haiku", r.h.callersTeamModel(req, "claude", orchBoard, ""))
		assert.Equal(t, "", r.h.callersTeamModel(req, "codex", orchBoard, ""), "another type")
		assert.Equal(t, "", r.h.callersTeamModel(req, "claude", "other-board", ""), "another board")
		assert.Equal(t, "", r.h.callersTeamModel(req, "claude", orchBoard, "some-other-coral"), "another computer")
		assert.Equal(t, "", r.h.callersTeamModel(httptest.NewRequest("POST", "/", nil), "claude", orchBoard, ""), "the Operator")
	})
}
