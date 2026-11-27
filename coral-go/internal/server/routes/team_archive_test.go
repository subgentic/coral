package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

const (
	taSID1 = "aaaaaaaa-1111-4111-8111-111111111111"
	taSID2 = "bbbbbbbb-2222-4222-8222-222222222222"
	taSID3 = "cccccccc-3333-4333-8333-333333333333"
)

// #21850: Archive team puts every agent of the team to sleep and archives it, marks the board archived and paused, and deletes nothing; Restore team undoes all of it, the agents back asleep.
func TestArchiveTeam_ArchiveAndRestore(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	handler.SetBoardHandler(NewBoardHandler(handler.bs))
	r := chi.NewRouter()
	r.Post("/api/board/{project}/archive", handler.ArchiveTeam)
	r.Delete("/api/board/{project}/archive", handler.RestoreTeam)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()

	registerTerminalAgent(t, ss, terminal, taSID1, "put-away", false) // running
	registerTerminalAgent(t, ss, terminal, taSID2, "put-away", true)  // already asleep
	registerTerminalAgent(t, ss, terminal, taSID3, "kept", false)     // another team's: untouched
	_, err := handler.bs.Subscribe(ctx, "put-away", "Lead", "Orchestrator", naming.SessionName("terminal", taSID1), nil, "all")
	require.NoError(t, err)
	_, err = handler.bs.PostMessage(ctx, "put-away", "Lead", "a message that must survive", nil)
	require.NoError(t, err)

	out := postArchiveOK(t, srv.URL+"/api/board/put-away/archive")
	assert.Equal(t, true, out["archived"])
	assert.EqualValues(t, 1, out["agents_slept"], "only the running agent is put to sleep")
	assert.EqualValues(t, 2, out["agents_archived"])
	for _, sid := range []string{taSID1, taSID2} {
		s, a := archFlags(t, ss, sid)
		assert.Equal(t, [2]int{1, 1}, [2]int{s, a}, "asleep and archived: %s", sid)
	}
	assert.False(t, terminal.HasSession(ctx, naming.SessionName("terminal", taSID1)), "the running agent's terminal is stopped")
	s, a := archFlags(t, ss, taSID3)
	assert.Equal(t, [2]int{0, 0}, [2]int{s, a}, "another team is untouched")
	assert.True(t, handler.bs.BoardArchived(ctx, "put-away"))
	assert.False(t, handler.bs.BoardArchived(ctx, "kept"))
	assert.True(t, handler.boardHandler.IsPaused("put-away"), "the board is paused, so its health check and reminders stop")
	projects, err := handler.bs.ListProjects(ctx)
	require.NoError(t, err)
	var listed, other bool
	for _, p := range projects {
		if p.Project == "put-away" {
			listed = true
			assert.True(t, p.Archived)
			assert.NotEmpty(t, p.ArchivedAt)
			assert.Equal(t, 1, p.MessageCount, "nothing is deleted: the team's message is still there")
		}
		if p.Project == "kept" {
			other = p.Archived
		}
	}
	assert.True(t, listed, "an archived team is still in the projects list, flagged")
	assert.False(t, other)

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/board/put-away/archive", bytes.NewReader([]byte("{}")))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var back map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&back))
	assert.Equal(t, false, back["archived"])
	assert.EqualValues(t, 2, back["agents_restored"])
	for _, sid := range []string{taSID1, taSID2} {
		s, a := archFlags(t, ss, sid)
		assert.Equal(t, [2]int{1, 0}, [2]int{s, a}, "back, asleep: %s", sid)
	}
	assert.False(t, handler.bs.BoardArchived(ctx, "put-away"))
	assert.False(t, handler.boardHandler.IsPaused("put-away"), "Restore clears the pause")
}

// A team with no agent can be archived too; the flag is all it has.
func TestArchiveTeam_NoAgents(t *testing.T) {
	_, handler, _, _ := setupSessionsTestServer(t)
	r := chi.NewRouter()
	r.Post("/api/board/{project}/archive", handler.ArchiveTeam)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	out := postArchiveOK(t, srv.URL+"/api/board/empty-team/archive")
	assert.EqualValues(t, 0, out["agents_archived"])
	assert.True(t, handler.bs.BoardArchived(context.Background(), "empty-team"))
}
