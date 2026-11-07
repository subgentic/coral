package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Full access is the widest skip of permission prompts, so through Coral Hub it meets the computer's switch "Coral Hub can turn on auto-accept" like every other skip (#14193, Security): switch off and
// an authentic owner is refused hub_auto_accept_disabled with nothing started or stored; switch on at Launch it works; below Launch hub_mode_too_low; a Hub user who is not the owner is refused;
// a request from this computer is not gated. A choice the hub made ends when the switch goes off; one made locally stays.
func TestFullAccessThroughTheHubMeetsTheOwnersSwitch(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil)
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	set := func(mode, allow string) {
		require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, mode))
		require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, allow))
	}
	owner := func(r *http.Request) *http.Request {
		r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		r.Header.Set(tunnel.HubRoleHeader, "owner")
		r.Header.Set(tunnel.HubUserHeader, "hub-user-1234abcd")
		return r
	}
	guest := func(r *http.Request) *http.Request {
		r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		r.Header.Set(tunnel.HubRoleHeader, "guest")
		r.Header.Set(tunnel.HubUserHeader, "hub-user-9999zzzz")
		return r
	}
	same := func(r *http.Request) *http.Request { return r }
	launch := func(who func(*http.Request) *http.Request) (*httptest.ResponseRecorder, string) {
		b, _ := json.Marshal(map[string]any{"agent_type": "claude", "working_dir": t.TempDir(), "keep_full_access": true, "backend": "tmux"})
		rec := httptest.NewRecorder()
		h.Launch(rec, who(httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))))
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		sid, _ := out["session_id"].(string)
		return rec, sid
	}
	n := 0
	restart := func(who func(*http.Request) *http.Request) (*httptest.ResponseRecorder, string) {
		n++
		sid := "hub-keep-restart-" + string(rune('a'+n))
		name := "claude-" + sid
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "coral-go", WorkingDir: t.TempDir()}))
		term.addSession(name, t.TempDir())
		b, _ := json.Marshal(map[string]any{"session_id": sid, "agent_type": "claude", "keep_full_access": true})
		req := dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/restart", bytes.NewReader(b)), map[string]string{"name": name})
		rec := httptest.NewRecorder()
		h.Restart(rec, who(req))
		return rec, sid
	}
	storedAnywhere := func() bool {
		set, err := ss.KeepFullAccessSessions(ctx)
		require.NoError(t, err)
		return len(set) > 0
	}
	refused := func(rec *httptest.ResponseRecorder, code, why string) {
		t.Helper()
		require.Equal(t, http.StatusForbidden, rec.Code, "%s: %s", why, rec.Body.String())
		if code != "" {
			require.Equal(t, code, codeOf(t, rec), why)
		}
	}

	// the switch off: an authentic owner is refused on launch and restart, nothing starts, nothing is stored
	set("launch", "false")
	before := len(term.sentCommands())
	rec, _ := launch(owner)
	refused(rec, "hub_auto_accept_disabled", "launch, switch off")
	rec, _ = restart(owner)
	refused(rec, "hub_auto_accept_disabled", "restart, switch off")
	require.Equal(t, before, len(term.sentCommands()), "nothing started")
	require.False(t, storedAnywhere(), "nothing stored")

	// a request from this computer is not gated
	rec, _ = launch(same)
	require.Equal(t, http.StatusOK, rec.Code, "local, switch off: "+rec.Body.String())
	localSID := func() string { _, s := launch(same); return s }()
	require.NotEmpty(t, localSID)

	// the switch on at Launch: the owner may, and a hub user who is not the owner may not
	set("launch", "true")
	rec, hubSID := launch(owner)
	require.Equal(t, http.StatusOK, rec.Code, "switch on, Launch: "+rec.Body.String())
	require.NotEmpty(t, hubSID)
	on, err := ss.KeepFullAccess(ctx, hubSID)
	require.NoError(t, err)
	require.True(t, on, "stored for the agent the hub's owner started")
	rec, _ = launch(guest)
	refused(rec, "", "a Hub user who is not the owner")
	require.Contains(t, rec.Body.String(), "Only the Operator")

	// below Launch
	set("interact", "true")
	rec, _ = launch(owner)
	refused(rec, "hub_mode_too_low", "below Launch")
	rec, _ = restart(owner)
	refused(rec, "hub_mode_too_low", "restart below Launch")

	// the choice the hub made ends with the switch; the one made locally stays
	hubOn, _ := ss.KeepFullAccess(ctx, hubSID)
	localOn, _ := ss.KeepFullAccess(ctx, localSID)
	require.True(t, hubOn)
	require.True(t, localOn, "the local launch stored its own choice too")
	cl := NewCloudHandler(ss, t.TempDir())
	require.NoError(t, cl.applyAllowAutoAccept(ctx, false))
	hubOn, _ = ss.KeepFullAccess(ctx, hubSID)
	localOn, _ = ss.KeepFullAccess(ctx, localSID)
	require.False(t, hubOn, "turning the switch off ended the choice the hub made: a later wake or restart through the hub does not bring Full access back")
	require.True(t, localOn, "the Operator's own choice outlives the hub's switch")
}

// (1) The keep route's own turn-on gate (QA, #14205): POST keep-full-access with on:true through the Hub meets the switch and the Launch mode like launch and restart do. Turning it OFF is always allowed.
func TestTheKeepRouteTurnOnGateThroughTheHub(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil)
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const sid = "33333333-4444-4555-8666-777777777701"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: "dev", WorkingDir: t.TempDir()}))
	name := "codex-" + sid
	set := func(mode, allow string) {
		require.NoError(t, ss.SetSetting(ctx, MaxModeSetting, mode))
		require.NoError(t, ss.SetSetting(ctx, AllowHubAutoAcceptSetting, allow))
	}
	owner := func(r *http.Request) *http.Request {
		r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		r.Header.Set(tunnel.HubRoleHeader, "owner")
		r.Header.Set(tunnel.HubUserHeader, "hub-user-1234abcd")
		return r
	}
	guest := func(r *http.Request) *http.Request {
		r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		r.Header.Set(tunnel.HubRoleHeader, "guest")
		r.Header.Set(tunnel.HubUserHeader, "hub-user-9999zzzz")
		return r
	}
	same := func(r *http.Request) *http.Request { return r }
	call := func(who func(*http.Request) *http.Request, on bool) *httptest.ResponseRecorder {
		b, _ := json.Marshal(map[string]any{"session_id": sid, "agent_type": "codex", "on": on})
		rt := chi.NewRouter()
		rt.Post("/api/sessions/live/{name}/keep-full-access", h.KeepFullAccessOpt)
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, who(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/keep-full-access", bytes.NewReader(b))))
		return rec
	}
	stored := func() bool { on, err := ss.KeepFullAccess(ctx, sid); require.NoError(t, err); return on }

	set("launch", "false")
	rec := call(owner, true)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, "hub_auto_accept_disabled", codeOf(t, rec))
	require.False(t, stored(), "refused: nothing stored")
	rec = call(same, true)
	require.Equal(t, http.StatusOK, rec.Code, "from this computer the switch does not apply: "+rec.Body.String())
	require.True(t, stored())
	rec = call(owner, false)
	require.Equal(t, http.StatusOK, rec.Code, "turning it OFF through the Hub is always allowed, switch off: "+rec.Body.String())
	require.False(t, stored())

	set("launch", "true")
	rec = call(guest, true)
	require.Equal(t, http.StatusForbidden, rec.Code, "a Hub user who is not the owner: "+rec.Body.String())
	require.False(t, stored())
	rec = call(owner, true)
	require.Equal(t, http.StatusOK, rec.Code, "switch on at Launch: "+rec.Body.String())
	require.True(t, stored())
	n, err := ss.ClearHubKeepFullAccess(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n, "it was recorded as the hub's choice")

	set("interact", "true")
	rec = call(owner, true)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "hub_mode_too_low", codeOf(t, rec))
	require.False(t, stored())
}

// (2) The Hub owner turning the switch off through POST /api/hub-auto-accept ends the choices the hub made, and not the local ones (QA, #14205).
func TestTheHubOwnersSwitchOffEndsTheChoicesTheHubMade(t *testing.T) {
	e := newHubAutoAcceptEnv(t)
	ctx := context.Background()
	for _, id := range []string{"44444444-5555-4666-8777-888888888801", "44444444-5555-4666-8777-888888888802"} {
		require.NoError(t, e.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "codex", AgentName: id[len(id)-2:], WorkingDir: t.TempDir()}))
	}
	hubID, localID := "44444444-5555-4666-8777-888888888801", "44444444-5555-4666-8777-888888888802"
	_, err := e.ss.SetKeepFullAccessFrom(ctx, hubID, true, store.KeepSourceHub)
	require.NoError(t, err)
	_, err = e.ss.SetKeepFullAccess(ctx, localID, true)
	require.NoError(t, err)

	rec := e.post(`{"allow":true}`, ownerHeaders(ownerLabel))
	require.Equal(t, 200, rec.Code, rec.Body.String())
	on, _ := e.ss.KeepFullAccess(ctx, hubID)
	require.True(t, on, "turning the switch ON ends nothing")

	rec = e.post(`{"allow":false}`, ownerHeaders(ownerLabel))
	require.Equal(t, 200, rec.Code, rec.Body.String())
	on, _ = e.ss.KeepFullAccess(ctx, hubID)
	require.False(t, on, "the owner's switch-off ended the choice the hub made")
	on, _ = e.ss.KeepFullAccess(ctx, localID)
	require.True(t, on, "the Operator's own choice stays")
}

// (3) Lowering the Hub's mode below Launch ends the choices the hub made, and not the local ones (QA, #14205); at Launch nothing ends.
func TestLoweringTheHubModeEndsTheChoicesTheHubMade(t *testing.T) {
	e := newHubAutoAcceptEnv(t)
	ctx := context.Background()
	hubID, localID := "55555555-6666-4777-8888-999999999901", "55555555-6666-4777-8888-999999999902"
	for _, id := range []string{hubID, localID} {
		require.NoError(t, e.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: id[len(id)-2:], WorkingDir: t.TempDir()}))
	}
	_, err := e.ss.SetKeepFullAccessFrom(ctx, hubID, true, store.KeepSourceHub)
	require.NoError(t, err)
	_, err = e.ss.SetKeepFullAccess(ctx, localID, true)
	require.NoError(t, err)

	require.NoError(t, e.h.applyMaxMode(ctx, tunnel.TierLaunch))
	on, _ := e.ss.KeepFullAccess(ctx, hubID)
	require.True(t, on, "at Launch the hub's choice stands")
	require.NoError(t, e.h.applyMaxMode(ctx, tunnel.TierInteract))
	on, _ = e.ss.KeepFullAccess(ctx, hubID)
	require.False(t, on, "lowered below Launch: the choice the hub made ended")
	on, _ = e.ss.KeepFullAccess(ctx, localID)
	require.True(t, on, "the local one stays")
}
