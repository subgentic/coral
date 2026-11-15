package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #18106: an agent on no team asks the Operator; the question is in the Operator's list and the answer is typed into that agent.
func TestSingleAgentAskReachesNeedsYouAndTheAnswerReachesTheAgent(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewAgentAsksHandler(store.NewSessionStore(db), nil)
	var typed []string
	h.deliver = func(_ context.Context, _ ptymanager.SessionTerminal, name, _, _, text, _ string) error {
		typed = append(typed, name+"|"+text)
		return nil
	}
	o := owner("0001")
	post := func(path, body string, withOwner bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		if withOwner {
			req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, o))
		}
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks", h.Create)
		rr.Post("/api/agent-asks/{id}/answer", h.Answer)
		rr.ServeHTTP(rec, req)
		return rec
	}
	assert.Equal(t, http.StatusUnauthorized, post("/api/agent-asks", `{"text":"which?"}`, false).Code, "only an agent's own token files a question")
	assert.Equal(t, http.StatusBadRequest, post("/api/agent-asks", `{"text":"  "}`, true).Code)
	assert.Equal(t, http.StatusBadRequest, post("/api/agent-asks", `{"text":"x","options":["a","b","c","d"]}`, true).Code)
	require.Equal(t, http.StatusOK, post("/api/agent-asks", `{"text":"Which database?","options":["Postgres","SQLite"]}`, true).Code)

	rows := h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	require.Len(t, rows, 1)
	assert.Equal(t, "agent", rows[0].Kind)
	assert.Equal(t, "", rows[0].Board)
	assert.Contains(t, rows[0].Text, "Which database?")
	assert.Contains(t, rows[0].Text, "- Postgres")

	require.Equal(t, http.StatusOK, post("/api/agent-asks", `{"text":"Which port?"}`, true).Code)
	rows = h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	require.Len(t, rows, 1, "a newer question replaces the agent's older open one")
	assert.Contains(t, rows[0].Text, "Which port?")

	assert.Equal(t, http.StatusBadRequest, post("/api/agent-asks/"+askIDText(rows[0].ID)+"/answer", `{"answer":" "}`, false).Code)
	assert.Equal(t, http.StatusOK, post("/api/agent-asks/"+askIDText(rows[0].ID)+"/answer", `{"answer":"8450"}`, false).Code)
	require.Len(t, typed, 1)
	assert.Contains(t, typed[0], o.SessionName)
	assert.Contains(t, typed[0], "8450")
	assert.Empty(t, h.Rows(httptest.NewRequest(http.MethodGet, "/", nil)), "answered: gone")
	assert.Equal(t, http.StatusConflict, post("/api/agent-asks/1/answer", `{"answer":"x"}`, false).Code, "an answered or replaced question is not answered twice")
}

func askIDText(n int64) string { return strconv.FormatInt(n, 10) }
