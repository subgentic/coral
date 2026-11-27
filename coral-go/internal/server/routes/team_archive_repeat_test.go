package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// Archive team twice (a double click, a Hub retry), then Restore team: the agents must come back.
func TestArchiveTeamTwiceThenRestoreBringsTheAgentsBack(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	handler.SetBoardHandler(NewBoardHandler(handler.bs))
	r := chi.NewRouter()
	r.Post("/api/board/{project}/archive", handler.ArchiveTeam)
	r.Delete("/api/board/{project}/archive", handler.RestoreTeam)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()
	registerTerminalAgent(t, ss, terminal, taSID1, "put-away", false)
	_, err := handler.bs.Subscribe(ctx, "put-away", "Lead", "Orchestrator", naming.SessionName("terminal", taSID1), nil, "all")
	require.NoError(t, err)
	postArchiveOK(t, srv.URL+"/api/board/put-away/archive")
	first, _ := handler.bs.ArchivedBoards(ctx)
	postArchiveOK(t, srv.URL+"/api/board/put-away/archive")
	again, _ := handler.bs.ArchivedBoards(ctx)
	assert.Equal(t, first["put-away"], again["put-away"], "a repeat keeps the archived time")
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/board/put-away/archive", bytes.NewReader([]byte("{}")))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	_, a1 := archFlags(t, ss, taSID1)
	assert.Equal(t, 0, a1, "the agent Archive team archived is back, though Archive team ran twice")
}
