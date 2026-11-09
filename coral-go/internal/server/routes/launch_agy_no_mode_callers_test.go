package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14741/#14767: what each kind of caller gets when it launches agy with NO mode named (observation first; the assertions below pin it).
func TestWhatEachCallerGetsLaunchingAgyWithNoMode(t *testing.T) {
	hubGuest := func(req *http.Request) *http.Request { // the Hub's real stamp, a guest (no owner role): TunneledAuthentic is true
		req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		req.Header.Set(tunnel.HubUserHeader, "hub-user-9999ffff")
		return asCaller(callerHub)(req)
	}
	callers := []struct {
		name string
		as   func(*http.Request) *http.Request
	}{
		{"the dashboard", asCaller(callerDashCookie)},
		{"the CLI", asCaller(callerCLISigned)},
		{"no caller (an automation)", func(req *http.Request) *http.Request { return req }},
		{"an agent", func(req *http.Request) *http.Request {
			return req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "11111111-2222-4333-8444-555555555555", SessionName: "claude-11111111-2222-4333-8444-555555555555"}))
		}},
		{"a Hub guest, switch off (the default)", hubGuest},
		{"a Hub request with a forged stamp", func(req *http.Request) *http.Request {
			req.Header.Set(tunnel.ViaHeader, "x")
			return asCaller(callerHub)(req)
		}},
	}
	// route, caller -> what a launch that names no mode gets: status, the mode it was recorded in (or the refusal's code). Claude is the control: agy must behave as it does.
	type outcome struct {
		status int
		what   string
	}
	want := map[string]outcome{
		"launch/the dashboard":                              {200, "auto"},
		"launch/the CLI":                                    {200, "auto"},
		"launch/no caller (an automation)":                  {200, "auto"},
		"launch/an agent":                                   {200, "default"}, // capped by the calling agent's own rank (this one records no mode: rank 0)
		"launch/a Hub guest, switch off (the default)":      {200, "default"}, // through the Hub without the owner's OK it falls back to Default, it is not refused
		"launch/a Hub request with a forged stamp":          {200, "default"},
		"launch-team/the dashboard":                         {200, "auto"},
		"launch-team/the CLI":                               {200, "auto"},
		"launch-team/no caller (an automation)":             {200, "auto"},
		"launch-team/an agent":                              {200, "default"},
		"launch-team/a Hub guest, switch off (the default)": {403, "hub_mode_too_low"}, // a team member that would start in Auto is checked by the Hub gate
		"launch-team/a Hub request with a forged stamp":     {403, "no_dashboard_provenance"},
	}
	for _, typ := range []string{"agy", "claude"} {
		for _, route := range []string{"launch", "launch-team"} {
			for _, c := range callers {
				r := newTrustRig(t)
				dir := filepath.Join(r.home, "Coral", "proj")
				require.NoError(t, os.MkdirAll(dir, 0o755))
				if c.name == "an agent" {
					require.NoError(t, r.h.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "11111111-2222-4333-8444-555555555555", AgentType: "claude", AgentName: "parent", WorkingDir: dir}))
				}
				body := map[string]any{"agent_type": typ, "working_dir": dir}
				path, handle := "/api/sessions/launch", r.h.Launch
				if route == "launch-team" {
					body = map[string]any{"board_name": "nm" + string(rune('a'+r.n)), "new_board": true, "working_dir": dir, "agent_type": "claude", "agents": []map[string]any{{"name": "C", "agent_type": typ}}}
					path, handle = "/api/sessions/launch-team", r.h.LaunchTeam
				}
				b, _ := json.Marshal(body)
				rec := httptest.NewRecorder()
				handle(rec, c.as(httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))))
				var out map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &out)
				got := outcome{rec.Code, ""}
				if rec.Code != http.StatusOK {
					got.what, _ = out["code"].(string)
				} else if agents, ok := out["agents"].([]any); ok && len(agents) > 0 {
					if m, ok := agents[0].(map[string]any); ok {
						got.what, _ = m["permission_mode"].(string)
					}
				} else {
					got.what, _ = out["permission_mode"].(string)
				}
				t.Logf("%-6s %-12s %-44s -> %d %s", typ, route, c.name, got.status, got.what)
				require.Equal(t, want[route+"/"+c.name], got, "%s %s %s", typ, route, c.name)
			}
		}
	}
}
