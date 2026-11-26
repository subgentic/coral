package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

func reservedNamesFixture(t *testing.T) *SessionsHandler {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	cfg := &config.Config{LogDir: t.TempDir()}
	cfg.UseCoralDir(t.TempDir())
	return NewSessionsHandler(db, cfg, nil, newMockTerminal(), bs)
}

// The name an automation posts under is nobody's: not a join's, not a launch's (on a team or not), not a rename's.
func TestNoPathNamesAMemberOrAnAgentAsAnAutomation(t *testing.T) {
	server, bh := setupBoardTestServer(t)
	for _, body := range []map[string]string{
		{"subscriber_id": "Automation: prod-alerts", "job_title": "Developer"},
		{"subscriber_id": "automation:x", "job_title": "Developer"},
		{"subscriber_id": "Dev", "job_title": "Automation: Lead"},
		{"subscriber_id": "Auto mation : y", "job_title": "Developer"},
	} {
		resp := postJSON(t, server.URL+"/api/board/p/subscribe", body)
		resp.Body.Close()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "join as %v", body)
	}
	subs, err := bh.bs.ListSubscribers(context.Background(), "p")
	require.NoError(t, err)
	assert.Empty(t, subs, "nobody joined")

	h := reservedNamesFixture(t)
	dir := t.TempDir()
	for _, launch := range []string{
		`{"agent_type":"claude","working_dir":"` + filepath.ToSlash(dir) + `","display_name":"Automation: prod-alerts","board_name":"crew"}`,
		`{"agent_type":"claude","working_dir":"` + filepath.ToSlash(dir) + `","display_name":"automation: x"}`, // no team at all
	} {
		rec := httptest.NewRecorder()
		h.Launch(rec, withActor(httptest.NewRequest(http.MethodPost, "/api/sessions/launch", strings.NewReader(launch)), Actor{Kind: ActorOperator, Name: "Operator"}))
		assert.Equal(t, http.StatusBadRequest, rec.Code, launch+": "+rec.Body.String())
		assert.Contains(t, rec.Body.String(), "reserved_name", launch)
	}
	for _, name := range []string{"Automation: prod-alerts", "AUTOMATION:x"} {
		rec := httptest.NewRecorder()
		h.SetDisplayName(rec, withActor(httptest.NewRequest(http.MethodPut, "/api/sessions/live/x/display-name", strings.NewReader(`{"session_id":"abc","display_name":"`+name+`"}`)), Actor{Kind: ActorOperator, Name: "Operator"}))
		assert.Equal(t, http.StatusBadRequest, rec.Code, "rename to "+name+": "+rec.Body.String())
		assert.Contains(t, rec.Body.String(), "reserved_name")
	}
	assert.True(t, board.ReservedMemberName("Automation: x"))
}
