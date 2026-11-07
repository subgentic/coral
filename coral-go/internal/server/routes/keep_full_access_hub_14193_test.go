package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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
