package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
)

// #16112 (from #16088): the Operator's answers to a Claude multiple-choice question and to a Codex dialog are recorded as prompt_answer, never as an allow or a reject: the page files that action under Answers and
// words it as the agent's question; only a recognised tool approval is a permission.
func TestAnAnswerToAClaudeQuestionAndToACodexDialogIsRecordedAsAnAnswer(t *testing.T) {
	for _, c := range []struct {
		name, agent, label string
		n                  int
	}{
		{"a Claude multiple-choice question", "claude", "Green", 2},
		{"a Codex dialog (hook review)", "codex", "Trust all and continue", 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, handler, term, ss := setupSessionsTestServer(t)
			const sid = "00000000-0000-0000-0000-000000016112"
			agentName := c.agent + "-q"
			require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: c.agent, AgentName: agentName, WorkingDir: "/tmp/test"}))
			term.addSession(agentName, "/tmp/test")
			fastPromptChecks(t)
			setScreen := func(s string) {
				term.mu.Lock()
				term.outputs[agentName] = s
				term.mu.Unlock()
			}
			if c.agent == "claude" {
				setScreen(screenQuestion)
				term.onRaw = func(string) { setScreen(screenIdleList) } // the agent takes the answer: the question goes
			} else {
				var mu sync.Mutex
				selected := 1
				setScreen(codexHookTrust(t, "tmux_open.txt"))
				term.onRaw = func(string) { // a digit only moves the selection on this menu; Enter confirms it
					mu.Lock()
					defer mu.Unlock()
					selected = 2
					setScreen(codexHookTrust(t, "tmux_selected_2.txt"))
				}
				term.onEnter = func(string) {
					mu.Lock()
					defer mu.Unlock()
					if selected == 2 {
						setScreen(codexHookTrust(t, "tmux_trusted.txt"))
					}
				}
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
			body, _ := json.Marshal(map[string]any{"n": c.n, "label": c.label, "session_id": sid, "agent_type": c.agent})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+agentName+"/answer-prompt", bytes.NewReader(body)))
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
			require.NoError(t, err)
			require.Len(t, rows, 1)
			assert.Equal(t, board.ActPromptAnswer, rows[0].Action, "an answer, not prompt_allow or prompt_reject")
			assert.Equal(t, c.label, rows[0].Note)
			assert.Equal(t, agentName, rows[0].ItemID)
		})
	}
}
