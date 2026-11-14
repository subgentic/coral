package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #16893 (walk 39 H1): after "Restart, same settings" the agent said it had no task and knew nothing of the work, though the board still held its claimed task. A restarted agent's first prompt
// names the task it was in the middle of. Failing-first: the launch of a restarted agent that holds a task carries the brief; one that holds none carries none.
func restartedLaunchText(t *testing.T, h *SessionsHandler, term *mockSessionTerminal, oldID, board, display string) string {
	t.Helper()
	oldName := "claude-" + oldID
	ctx := context.Background()
	ss := h.ss
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: oldID, AgentType: "claude", AgentName: "tip", WorkingDir: t.TempDir(), BoardName: &board, DisplayName: &display}))
	term.addSession(oldName, t.TempDir())
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+oldName+"/restart", strings.NewReader(`{"session_id":"`+oldID+`","agent_type":"claude"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	rc := chi.NewRouteContext()
	rc.URLParams.Add("name", oldName)
	h.Restart(rec, req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	// the launch command may carry the prompt inline or in a file it names: read both
	all := strings.Join(term.sentCommands(), "\n")
	for _, f := range strings.Fields(strings.NewReplacer("'", " ", "\"", " ").Replace(all)) {
		if filepath.IsAbs(f) && strings.HasPrefix(filepath.Base(f), "coral_prompt_") {
			if b, err := os.ReadFile(f); err == nil && len(b) < 1<<20 {
				all += "\n" + string(b)
			}
		}
	}
	return all
}

func TestARestartedAgentIsToldTheTaskItHeld(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	ctx := context.Background()
	const board = "tip-team"
	const display = "Lead Developer"
	role := naming.SubscriberID(display, "claude")
	_, err := h.bs.Subscribe(ctx, board, role, role, "claude-held-0001", nil, "mentions", false)
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, board, "Build the tip calculator", "body", "high", "Orchestrator", role)
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, board, role, task.ID)
	require.NoError(t, err)

	text := restartedLaunchText(t, h, term, "held-0001", board, display)
	assert.Contains(t, text, "[Coral restart]", "the restarted agent is told it is a new conversation")
	assert.Contains(t, text, "Task #"+itoa(task.ID), "and which task it held")
	assert.Contains(t, text, "Build the tip calculator")
	assert.Contains(t, text, "coral-board task show "+itoa(task.ID))
}

func TestARestartedAgentWithNoTaskGetsNoBrief(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	text := restartedLaunchText(t, h, term, "nothing-0001", "tip-team", "Designer")
	assert.NotContains(t, text, "[Coral restart]")
}

func TestRestartBriefTextIsOneLineOfTheTitleAndCut(t *testing.T) {
	assert.Equal(t, "", restartBriefText(nil, "/x"))
	assert.Equal(t, "p\n\nb", withRestartBrief("p\n", "b"))
	assert.Equal(t, "b", withRestartBrief("", "b"))
	assert.Equal(t, "p", withRestartBrief("p", ""))
}
