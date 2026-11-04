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

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #13425: a person who starts or wakes an agent in the home folder itself from the dashboard is asked once (409 home_folder, nothing started); Launch anyway goes through. A warning, never a refusal:
// an agent, the command line, a script and every other folder are unchanged.
func asDashCookie13425(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashCookie))
}

func homeFolderOf(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

func TestLaunchInTheHomeFolderAsksTheDashboardOnce(t *testing.T) {
	home := homeFolderOf(t)
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	launch := func(dir string, extra map[string]any, wrap func(*http.Request) *http.Request) *httptest.ResponseRecorder {
		body := map[string]any{"agent_type": "claude", "working_dir": dir}
		for k, v := range extra {
			body[k] = v
		}
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		h.Launch(rec, wrap(httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))))
		return rec
	}
	before := len(term.sentCommands())
	rec := launch(home, nil, asDashCookie13425)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	var ask map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ask))
	assert.Equal(t, homeFolderCode, ask["code"])
	assert.Equal(t, homeFolderMessage, ask["error"])
	assert.Equal(t, before, len(term.sentCommands()), "nothing started")

	rec = launch(home, map[string]any{"confirm_home_folder": true}, asDashCookie13425)
	assert.Equal(t, http.StatusOK, rec.Code, "Launch anyway goes through: "+rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"ok":true`)

	// unchanged: a folder inside the home folder, and a script or the command line (no dashboard caller) in the home folder itself
	inner := filepath.Join(home, "project")
	require.NoError(t, os.MkdirAll(inner, 0o755))
	assert.Equal(t, http.StatusOK, launch(inner, nil, asDashCookie13425).Code, "a project folder is not asked about")
	assert.Equal(t, http.StatusOK, launch(home, nil, func(r *http.Request) *http.Request { return r }).Code, "automation is never asked")
}

func TestTeamLaunchInTheHomeFolderAsksTheDashboardOnce(t *testing.T) {
	home := homeFolderOf(t)
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	start := func(extra map[string]any) *httptest.ResponseRecorder {
		body := map[string]any{"board_name": "homeask", "new_board": true, "working_dir": home, "agent_type": "claude", "agents": []map[string]any{{"name": "a"}}}
		for k, v := range extra {
			body[k] = v
		}
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, asDashCookie13425(httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))))
		return rec
	}
	before := len(term.sentCommands())
	rec := start(nil)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), homeFolderCode)
	assert.Equal(t, before, len(term.sentCommands()), "nothing started")
	rec = start(map[string]any{"confirm_home_folder": true})
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestWakeInTheHomeFolderAsksTheDashboardOnce(t *testing.T) {
	home := homeFolderOf(t)
	_, h, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const id = "6682ebdf-65a4-4396-8ef3-26ead8208b8a"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "cknorowski", WorkingDir: home, IsSleeping: 1}))
	wake := func(query string, wrap func(*http.Request) *http.Request) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+id+"/wake"+query, nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("sessionID", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		h.WakeSession(rec, wrap(req))
		return rec
	}
	started := func() bool {
		term.mu.Lock()
		defer term.mu.Unlock()
		return term.sessions[naming.SessionName("claude", id)] != nil
	}
	rec := wake("", asDashCookie13425)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), homeFolderCode)
	assert.False(t, started(), "nothing started")

	rec = wake("?confirm_home_folder=1", asDashCookie13425)
	assert.Contains(t, rec.Body.String(), `"ok":true`, rec.Body.String())
	assert.True(t, started())
}

func TestWakeOfAnAutomationCallerOrAProjectFolderIsNotAsked(t *testing.T) {
	home := homeFolderOf(t)
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	inner := filepath.Join(home, "project")
	require.NoError(t, os.MkdirAll(inner, 0o755))
	for name, c := range map[string]struct {
		dir  string
		wrap func(*http.Request) *http.Request
	}{
		"automation in home":     {home, func(r *http.Request) *http.Request { return r }},
		"dashboard in a project": {inner, asDashCookie13425},
	} {
		t.Run(name, func(t *testing.T) {
			id := "6682ebdf-65a4-4396-8ef3-26ead8208b" + map[string]string{"automation in home": "01", "dashboard in a project": "02"}[name]
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "m", WorkingDir: c.dir, IsSleeping: 1}))
			req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+id+"/wake", nil)
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("sessionID", id)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
			rec := httptest.NewRecorder()
			h.WakeSession(rec, c.wrap(req))
			assert.Contains(t, rec.Body.String(), `"ok":true`, rec.Body.String())
		})
	}
}
