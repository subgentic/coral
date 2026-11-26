package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

const wfBody = `"steps":[{"name":"check","type":"shell","command":"true"}]`

// The team an automation posts to is set by the Operator at this computer, for a team that exists here; an agent, a Hub link and an unknown team never set it, and changing it ends the tokens of its runs.
func TestOnlyTheOperatorAtThisComputerSetsTheTeamAnAutomationPostsTo(t *testing.T) {
	cfg := config.Load(t.TempDir())
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "crew", "Dev", "Developer", "claude-dev", nil, "")
	require.NoError(t, err)
	h := NewWorkflowHandler(db, cfg)
	h.SetBoardStore(bs)
	op, agent := Actor{Kind: ActorOperator, Name: "Operator"}, Actor{Kind: ActorToken, Name: "Dev", Session: "claude-dev"}
	r := chi.NewRouter()
	var actor = op
	var tunneled bool
	as := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			if tunneled {
				req.Header.Set(tunnel.ViaHeader, "x")
			}
			next(w, withActor(req, actor))
		}
	}
	r.Post("/api/workflows", as(h.CreateWorkflow))
	r.Put("/api/workflows/{workflowID}", as(h.UpdateWorkflow))
	r.Delete("/api/workflows/{workflowID}", as(h.DeleteWorkflow))
	do := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}
	boardOf := func(id int64) string {
		wf, err := h.ws.GetWorkflow(ctx, id)
		require.NoError(t, err)
		return wf.Board
	}

	rec := do("POST", "/api/workflows", `{"name":"prod-alerts",`+wfBody+`,"board":"crew"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created struct {
		ID    int64  `json:"id"`
		Board string `json:"board"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	assert.Equal(t, "crew", created.Board)
	assert.Equal(t, "crew", boardOf(created.ID))
	id := strconv.FormatInt(created.ID, 10)

	// a token minted for it ends when the team changes
	live, err := db.MintAutomationToken(ctx, store.AutomationTokenSpec{RunID: 1, WorkflowID: created.ID, WorkflowName: "prod-alerts", Project: "crew", TTL: time.Minute}, time.Now())
	require.NoError(t, err)

	actor = agent
	assert.Equal(t, http.StatusForbidden, do("PUT", "/api/workflows/"+id, `{"board":"crew"}`).Code, "an agent never sets it")
	assert.Equal(t, http.StatusForbidden, do("POST", "/api/workflows", `{"name":"w2",`+wfBody+`,"board":"crew"}`).Code, "nor at creation")
	actor = op
	tunneled = true
	rec = do("PUT", "/api/workflows/"+id, `{"board":"crew"}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, "a Hub link never sets it")
	tunneled = false
	_, err = db.AutomationTokenOf(ctx, live, time.Now())
	assert.NoError(t, err, "refused changes end nothing")

	assert.Equal(t, http.StatusBadRequest, do("PUT", "/api/workflows/"+id, `{"board":"nowhere"}`).Code, "a team that is not on this computer")
	assert.Equal(t, http.StatusBadRequest, do("PUT", "/api/workflows/"+id, `{"board":"Automation: crew"}`).Code, "the reserved name is no team")
	assert.Equal(t, "crew", boardOf(created.ID))

	assert.Equal(t, http.StatusOK, do("PUT", "/api/workflows/"+id, `{"board":""}`).Code, "the Operator clears it")
	assert.Equal(t, "", boardOf(created.ID))
	_, err = db.AutomationTokenOf(ctx, live, time.Now())
	assert.Error(t, err, "changing the team ended the tokens of its runs")

	assert.Equal(t, http.StatusOK, do("PUT", "/api/workflows/"+id, `{"board":"crew"}`).Code)
	live, _ = db.MintAutomationToken(ctx, store.AutomationTokenSpec{RunID: 2, WorkflowID: created.ID, WorkflowName: "prod-alerts", Project: "crew", TTL: time.Minute}, time.Now())
	assert.Equal(t, http.StatusOK, do("PUT", "/api/workflows/"+id, `{"enabled":0}`).Code)
	_, err = db.AutomationTokenOf(ctx, live, time.Now())
	assert.Error(t, err, "turning it off ends them too")

	live, _ = db.MintAutomationToken(ctx, store.AutomationTokenSpec{RunID: 3, WorkflowID: created.ID, WorkflowName: "prod-alerts", Project: "crew", TTL: time.Minute}, time.Now())
	assert.Equal(t, http.StatusOK, do("DELETE", "/api/workflows/"+id, "").Code)
	_, err = db.AutomationTokenOf(ctx, live, time.Now())
	assert.Error(t, err, "and deleting it")
}
