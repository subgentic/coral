package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

const chiefSID = "11111111-2222-4333-8444-555555555555"

// /chief (#11450): the Operator's phone page for one agent. Security's conditions: it is answered only while chief_page is on (404 otherwise); the agent is the team and session the
// Operator RECORDED (chief_team, chief_session), checked on every request, never "any team named chief"; the page serves no data of its own.
func TestChiefPageServesOnlyTheRecordedAgentWhileTheSettingIsOn(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	get := func() (int, string) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/chief", nil)
		req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000" // this computer: the sign-in rule for another address is the router's own
		srv.Router().ServeHTTP(rec, req)
		b, _ := io.ReadAll(rec.Result().Body)
		return rec.Code, string(b)
	}
	set := func(k, v string) { require.NoError(t, ss.SetSetting(ctx, k, v)) }
	live := func(id, team string) {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "chief", WorkingDir: t.TempDir(), BoardName: &team}))
	}

	// Behind the normal sign-in: an address that is not this computer, with no credential, is sent to sign in, whatever the setting says.
	{
		set("chief_page", "true")
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/chief", nil)
		req.RemoteAddr = "203.0.113.9:50000"
		srv.Router().ServeHTTP(rec, req)
		assert.Equal(t, http.StatusTemporaryRedirect, rec.Code, "not signed in: sent to sign in")
		assert.NotContains(t, rec.Body.String(), "Chief")
		set("chief_page", "false")
	}
	code, _ := get()
	assert.Equal(t, http.StatusNotFound, code, "off by default: a 404")

	set("chief_page", "true")
	code, body := get()
	assert.Equal(t, http.StatusOK, code)
	assert.NotContains(t, body, `data-target-session-id="`+chiefSID, "nothing recorded: no agent is shown")
	assert.Contains(t, body, "Chief is not set up", "it says so, with no data")

	// An agent that made a team named chief is not Chief: only the recorded session is.
	live("99999999-2222-4333-8444-555555555555", "chief")
	_, body = get()
	assert.NotContains(t, body, "99999999-2222-4333-8444-555555555555", "a team named chief is not enough")

	set("chief_team", "chief")
	set("chief_session", chiefSID)
	_, body = get()
	assert.NotContains(t, body, `data-target-session-id="`+chiefSID, "the recorded session is not running")

	live(chiefSID, "somewhere-else")
	_, body = get()
	assert.NotContains(t, body, `data-target-session-id="`+chiefSID, "the recorded session is not on the recorded team")

	live(chiefSID, "chief")
	_, body = get()
	assert.Contains(t, body, `data-target-session-id="`+chiefSID+`"`, "the recorded session on the recorded team is shown")
	assert.Contains(t, body, `data-chief="true"`)

	set("chief_page", "false")
	code, _ = get()
	assert.Equal(t, http.StatusNotFound, code, "turned off again: a 404")
}
