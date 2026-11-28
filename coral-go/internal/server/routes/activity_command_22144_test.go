package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/faketoken"
	"github.com/subgentic/coral/internal/store"
)

// #22144 (Security's design call): an answered permission prompt's Activity row keeps the command the agent asked to run, as its card showed it, redacted before it is stored. A fake token only (Security's MUST 5).
var fakeCommandToken = faketoken.GitHub("abcdefghijklmnopqrstuvwxyz0123456789")

// answerPermission answers the Bash permission prompt drawn for command with option n and returns the one Activity row the answer made.
func answerPermission(t *testing.T, command string, n int, label string) board.OperatorAction {
	t.Helper()
	_, handler, term, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-000000022144"
	agentName := "claude-cmd"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: agentName, WorkingDir: "/tmp/test"}))
	term.addSession(agentName, "/tmp/test")
	fastPromptChecks(t)
	term.mu.Lock()
	term.outputs[agentName] = claudeBashScreen(command)
	term.mu.Unlock()
	term.onRaw = func(string) { // the agent takes the answer: the prompt goes
		term.mu.Lock()
		term.outputs[agentName] = screenIdleList
		term.mu.Unlock()
	}
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie)))
		})
	})
	r.Use(ActivityRecorder(bs, nil))
	r.Post("/api/sessions/live/{name}/answer-prompt", handler.AnswerPrompt)
	body, _ := json.Marshal(map[string]any{"n": n, "label": label, "session_id": sid, "agent_type": "claude"})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+agentName+"/answer-prompt", bytes.NewReader(body)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	chk, err := bs.VerifyActivity(context.Background())
	require.NoError(t, err)
	assert.True(t, chk.Intact, "the row with its command verifies in the chain")
	return rows[0]
}

func TestAnAllowedCommandIsKeptOnItsRowRedactedAsItsCardShowedIt(t *testing.T) {
	row := answerPermission(t, ` curl -H "Authorization: token `+fakeCommandToken+`" https://example.invalid/<b>x</b>`, 1, "Yes")
	assert.Equal(t, board.ActPromptAllow, row.Action)
	assert.NotContains(t, row.Command, fakeCommandToken, "the token is redacted before it is stored")
	assert.Contains(t, row.Command, "curl -H")
	assert.Contains(t, row.Command, "<b>x</b>", "markup is kept as text: the page draws it with textContent (Security's MUST 4)")
	assert.False(t, row.CommandCut)
}

func TestARejectedCommandWithAHiddenCharacterIsKeptWithTheCharacterWrittenOut(t *testing.T) {
	row := answerPermission(t, " rm -rf build\u200b/tmp", 2, "No")
	assert.Equal(t, board.ActPromptReject, row.Action)
	assert.Contains(t, row.Command, "<U+200B>", "the hidden character is written out, as the card shows it")
	assert.NotContains(t, row.Command, "\u200b")
}

func TestACommandNotReadWholeIsNotKept(t *testing.T) {
	big := strings.Repeat(" echo "+strings.Repeat("x", 80)+"\n", 60) // longer than a card shows: Unreadable
	row := answerPermission(t, strings.TrimRight(big, "\n"), 2, "No")
	assert.Equal(t, board.ActPromptReject, row.Action)
	assert.Empty(t, row.Command, "a request Coral did not read whole is never kept")
}

// Security's MUST 3: only the person reads the command. An agent's token (or any caller that is not a person) is refused the record, so no command reaches it.
func TestOnlyThePersonReadsARowsCommand(t *testing.T) {
	e := newReviewEnv(t, true)
	cmd := `echo <b>hi</b>`
	require.NoError(t, e.h.bs.RecordActivity(context.Background(), board.ActivityMeta{Actor: "local", Source: "local", Command: cmd}, board.ActPromptAllow, "agent", "claude-cmd", "", ""))

	person := e.activityServer(t, true)
	code, out := getActivity(t, person.URL, "", nil)
	require.Equal(t, http.StatusOK, code, out)
	rows := out["actions"].([]any)
	require.Len(t, rows, 1)
	assert.Equal(t, cmd, rows[0].(map[string]any)["command"])

	agent := e.activityServer(t, false)
	resp, err := http.Get(agent.URL + "/api/activity")
	require.NoError(t, err)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.NotContains(t, string(raw), "command")
	assert.NotContains(t, string(raw), "echo")
}
