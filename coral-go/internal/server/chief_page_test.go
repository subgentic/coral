package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
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

// Chief through Coral Hub (#11470): the Hub draws its own Chief page, so it asks the machine only WHICH agent is Chief: GET /api/chief answers {enabled, session_id, team}, and through the Hub only to the computer's
// OWNER. A viewer, a guest, a guide, a forged stamp or another hub account is refused before any setting is read. The answer is chiefRecorded's, the same one the local page uses: the setting on, and the
// recorded session live on the recorded team.
func TestChiefStateThroughCoralHubIsTheOwnersAlone(t *testing.T) {
	const owner, other = "hub-user-0a1b2c3d", "hub-user-ffffffff"
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	// after the server is built: its own wiring sets these two at startup
	routes.SetHubOwnerRecord(func(context.Context) (string, string, error) { return tunnel.OwnerKindPersonal, "", nil })
	routes.SetHubOwnerLabel(func(context.Context) (string, error) { return owner, nil })
	t.Cleanup(func() { routes.SetHubOwnerRecord(nil); routes.SetHubOwnerLabel(nil) })
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	call := func(h map[string]string) (int, map[string]any, string) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/chief", nil)
		req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000" // the connector is this computer
		for k, v := range h {
			req.Header.Set(k, v)
		}
		srv.Router().ServeHTTP(rec, req)
		b, _ := io.ReadAll(rec.Result().Body)
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return rec.Code, out, string(b)
	}
	ownerStamp := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: tunnel.HubRoleOwner, tunnel.HubUserHeader: owner}
	team := "chief"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: chiefSID, AgentType: "claude", AgentName: "chief", WorkingDir: t.TempDir(), BoardName: &team}))
	for k, v := range map[string]string{"chief_page": "true", "chief_team": "chief", "chief_session": chiefSID} {
		require.NoError(t, ss.SetSetting(ctx, k, v))
	}

	for name, h := range map[string]map[string]string{
		"a hub viewer (no owner marker)":          {tunnel.ViaHeader: cloud.ViaSecret()},
		"a viewer with a hub user":                {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: owner},
		"a forged tunnel stamp claiming owner":    {tunnel.ViaHeader: "1", tunnel.HubRoleHeader: tunnel.HubRoleOwner, tunnel.HubUserHeader: owner},
		"the owner marker of a different account": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: tunnel.HubRoleOwner, tunnel.HubUserHeader: other},
	} {
		code, out, raw := call(h)
		if h[tunnel.ViaHeader] == "1" { // a stamp that is not the connector's own: the sign-in layer refuses it outright, before this route
			assert.Equal(t, http.StatusUnauthorized, code, name)
		} else {
			assert.Equal(t, http.StatusForbidden, code, name)
			assert.Equal(t, "owner_only", out["code"], name)
		}
		assert.NotContains(t, raw, chiefSID, name+": nothing of the recorded agent")
	}

	code, out, _ := call(ownerStamp)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, map[string]any{"enabled": true, "session_id": chiefSID, "team": "chief"}, out, "the owner is told the recorded Chief")

	// the same checks as the local page, on every request
	elsewhere := "somewhere-else"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: chiefSID, AgentType: "claude", AgentName: "chief", WorkingDir: t.TempDir(), BoardName: &elsewhere}))
	_, out, _ = call(ownerStamp)
	assert.Equal(t, map[string]any{"enabled": true, "session_id": "", "team": ""}, out, "the recorded session is no longer on the recorded team: no agent")
	require.NoError(t, ss.SetSetting(ctx, "chief_page", "false"))
	_, out, _ = call(ownerStamp)
	assert.Equal(t, map[string]any{"enabled": false, "session_id": "", "team": ""}, out, "setting off: not enabled, nothing named")

	// at this computer (no tunnel) the route answers the dashboard as any local read, and the page route is as before
	code, out, _ = call(nil)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["enabled"])
}

// QA's Chief walk (#11499): the Operator records the team by its NAME (what they see and type), while a live row's board_name holds the board's ID. The name is resolved through the board's label; an id still works; a name that is not
// the label of the board the recorded session is on, or is the label of another board, is not Chief.
func TestChiefPageResolvesTheRecordedTeamNameToItsBoard(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	get := func() string {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/chief", nil)
		req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000"
		srv.Router().ServeHTTP(rec, req)
		b, _ := io.ReadAll(rec.Result().Body)
		return string(b)
	}
	set := func(k, v string) { require.NoError(t, ss.SetSetting(ctx, k, v)) }
	chiefBoard, err := srv.BoardStore().CreateBoard(ctx, "chiefdesk", "test")
	require.NoError(t, err)
	other, err := srv.BoardStore().CreateBoard(ctx, "devteam", "test")
	require.NoError(t, err)
	id := chiefBoard.ID
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: chiefSID, AgentType: "claude", AgentName: "chief", WorkingDir: t.TempDir(), BoardName: &id}))
	set("chief_page", "true")
	set("chief_session", chiefSID)
	shown := func() bool { return strings.Contains(get(), `data-target-session-id="`+chiefSID+`"`) }

	set("chief_team", "chiefdesk")
	assert.True(t, shown(), "the team's name, as the Operator types it, resolves to its board")
	set("chief_team", chiefBoard.ID)
	assert.True(t, shown(), "the board id still works")
	set("chief_team", "devteam")
	assert.False(t, shown(), "the label of another board is not the recorded session's team")
	set("chief_team", other.ID)
	assert.False(t, shown(), "nor is its id")
	set("chief_team", "ChiefDesk")
	assert.False(t, shown(), "a name is exact: no guessing by case")
}

// #11502 (QA's Chief walk, finding 4): the pop-out and /chief name an agent from GET /api/sessions/{id}/resolve, merged over the live row. A name the Operator gave later (session_meta, what the list shows) must win over the
// name the agent was launched with (live_sessions.display_name, here the team member "Orchestrator"), or the header says Chief on the first paint and Orchestrator once the resolver's record is merged in.
func TestResolveNamesTheAgentByItsRenamedDisplayName(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	launched := "Orchestrator"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: chiefSID, AgentType: "claude", AgentName: "work", WorkingDir: t.TempDir(), DisplayName: &launched}))
	resolve := func() map[string]any {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+chiefSID+"/resolve", nil)
		req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000"
		srv.Router().ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	assert.Equal(t, "Orchestrator", resolve()["display_name"], "before a rename: the name it was launched with")
	require.NoError(t, ss.SetDisplayName(ctx, chiefSID, "Chief"))
	out := resolve()
	assert.Equal(t, "Chief", out["display_name"], "after a rename: the renamed display name, as the list says")
	assert.Equal(t, "Orchestrator", out["board_job_title"], "the job title stays the member's")
}

// The board whose messages to another team may be labelled "Chief" (#11508) is the one the recorded LIVE session is on, while chief_page is on: never a board picked by its name, never with the page off.
func TestChiefBoardIDIsTheRecordedLiveSessionsBoardWhileThePageIsOn(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	set := func(k, v string) { require.NoError(t, ss.SetSetting(ctx, k, v)) }
	live := func(id, team string) {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "chief", WorkingDir: t.TempDir(), BoardName: &team}))
	}
	set("chief_team", "chief")
	set("chief_session", chiefSID)
	live(chiefSID, "chief")
	require.Equal(t, "", srv.chiefBoardID(ctx), "chief_page is off")
	set("chief_page", "true")
	require.Equal(t, "chief", srv.chiefBoardID(ctx))
	live(chiefSID, "somewhere-else")
	require.Equal(t, "", srv.chiefBoardID(ctx), "the recorded session is on another team")
	live("99999999-2222-4333-8444-555555555555", "chief")
	live(chiefSID, "chief")
	set("chief_session", "99999999-2222-4333-8444-555555555555")
	require.Equal(t, "chief", srv.chiefBoardID(ctx), "the recorded session, whichever it is")
	set("chief_session", "not-a-session-id")
	require.Equal(t, "", srv.chiefBoardID(ctx), "no valid session recorded")
	set("chief_session", chiefSID)
	set("chief_team", "")
	require.Equal(t, "", srv.chiefBoardID(ctx), "no team recorded")
	// Recorded by the board's label: the live row's board is the id.
	if srv.boardStore != nil {
		b, err := srv.boardStore.CreateBoard(ctx, "Chief Team", "test")
		require.NoError(t, err)
		live(chiefSID, b.ID)
		set("chief_team", "Chief Team")
		require.Equal(t, b.ID, srv.chiefBoardID(ctx), "the label, exactly")
		set("chief_team", "chief team")
		require.Equal(t, "", srv.chiefBoardID(ctx), "not another spelling")
	}
}
