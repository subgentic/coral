package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #16434: a Codex agent started on its CLI's own default has no model stored; its row's model line came from what the CLI reported. After "Restart, same settings" the new session had nothing yet, so the
// row lost the line while a Claude row with a stored model kept it. The model the replaced row showed is carried to the new session (display only).
func restartSame(t *testing.T, h *SessionsHandler, term *mockSessionTerminal, ls *store.LiveSession) *store.LiveSession {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, h.ss.RegisterLiveSession(ctx, ls))
	if ls.ObservedModel != nil { // a register does not store it: a hook reports it later
		require.NoError(t, h.ss.SetObservedModel(ctx, ls.SessionID, *ls.ObservedModel))
	}
	name := ls.AgentType + "-" + ls.SessionID
	term.addSession(name, ls.WorkingDir)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/restart", strings.NewReader(`{"session_id":"`+ls.SessionID+`","agent_type":"`+ls.AgentType+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rc := chi.NewRouteContext()
	rc.URLParams.Add("name", name)
	rec := httptest.NewRecorder()
	h.Restart(rec, req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	return replaced(t, h.ss, ls.SessionID)
}

func TestARestartedAgentOnTheCLIDefaultKeepsItsModelLine(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	seen := "GPT-6.1-Sol"
	fresh := restartSame(t, h, term, &store.LiveSession{SessionID: "model-line-0001", AgentType: "codex", AgentName: "cx", WorkingDir: t.TempDir(), ObservedModel: &seen})
	require.NotNil(t, fresh)
	assert.Equal(t, seen, ptrValue(fresh.ObservedModel), "the new session shows the model the replaced row showed")
	assert.Empty(t, ptrValue(fresh.Model), "and it is display only: no model is stored to launch with")
}

func TestARestartedAgentWithAStoredModelIsNotGivenAnObservedOne(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	stored, seen := "sonnet", "Sonnet 5.5"
	fresh := restartSame(t, h, term, &store.LiveSession{SessionID: "model-line-0002", AgentType: "claude", AgentName: "cl", WorkingDir: t.TempDir(), Model: &stored, ObservedModel: &seen})
	require.NotNil(t, fresh)
	assert.Equal(t, stored, ptrValue(fresh.Model))
	assert.Empty(t, ptrValue(fresh.ObservedModel), "a stored model already names the row")
}

func ptrValue(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
