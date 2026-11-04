package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #13208 (goal #218): what an agent LOADED is what it read with skills get, kept per session; the Operator reads that list for any agent type, asleep or not, as names, versions and times, never a skill's text.
func TestAnAgentsLoadedSkillsAreWhatItReadWithSkillsGet(t *testing.T) {
	e := newSkillsEnv(t)
	e.liveAgent("sid-a")
	e.liveAgent("sid-b")
	row, _ := e.publish(map[string]string{"SKILL.md": skillMD, "references/pg.md": "SECRET-REFERENCE-TEXT"}, store.PublisherOperator)
	other, _ := e.publish(map[string]string{"SKILL.md": "---\nname: other-skill\ndescription: Another.\n---\n# Other\n"}, store.PublisherOperator)

	h := &SessionsHandler{ss: e.ss}
	r := chi.NewRouter()
	r.Get("/api/sessions/live/{name}/loaded-skills", h.AgentLoadedSkills)
	list := func(sid string, hdr map[string]string) (int, map[string]any, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/sessions/live/claude-"+sid+"/loaded-skills?session_id="+sid, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		if hdr["no-dash"] != "" {
			req = httptest.NewRequest(http.MethodGet, req.URL.String(), nil)
			for k, v := range hdr {
				req.Header.Set(k, v)
			}
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		out := map[string]any{}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out, w.Body.String()
	}

	// nothing read yet: an empty list, not an error
	code, out, b0 := list("sid-a", nil)
	require.Equal(t, 200, code, b0)
	assert.Equal(t, "claude", out["agent_type"])
	assert.Equal(t, []any{}, out["skills"], "a folder is not scanned: nothing was read, nothing is listed")

	// the agent reads the skill twice (SKILL.md, then a file); the Operator's own read in the page is not a load; a search is not a load
	code, _ = e.asAgent("sid-a", "claude-a", "GET", "/api/agent/skills/"+row.ID)
	require.Equal(t, 200, code)
	code, _ = e.asAgent("sid-a", "claude-a", "GET", "/api/agent/skills/"+row.ID+"?file=references/pg.md")
	require.Equal(t, 200, code)
	code, _ = e.get("/api/agent/skills/"+other.ID, "operator")
	require.Equal(t, 200, code)
	code, _ = e.asAgent("sid-a", "claude-a", "GET", "/api/agent/skills/search?q=another")
	require.Equal(t, 200, code)

	code, out, body := list("sid-a", nil)
	require.Equal(t, 200, code, body)
	skills := out["skills"].([]any)
	require.Len(t, skills, 1, body)
	s := skills[0].(map[string]any)
	assert.Equal(t, row.ID, s["id"])
	assert.Equal(t, "release-notes", s["name"])
	assert.EqualValues(t, row.Version, s["version"])
	assert.EqualValues(t, 2, s["loads"])
	assert.Equal(t, "approved", s["status"])
	assert.Equal(t, false, s["newer_version"])
	assert.NotEmpty(t, s["first_at"])
	assert.NotEmpty(t, s["last_at"])
	for _, leaked := range []string{"SECRET-REFERENCE-TEXT", "List the PRs", "Writes release notes"} {
		assert.NotContains(t, body, leaked, "no skill text reaches the answer")
	}

	// another agent has its own record
	_, out, _ = list("sid-b", nil)
	assert.Equal(t, []any{}, out["skills"])

	// the Operator removes the skill: it still shows, marked removed
	code, _ = e.call("DELETE", "/api/skills/"+row.ID, "", "operator")
	require.Equal(t, 200, code)
	_, out, _ = list("sid-a", nil)
	removed := out["skills"].([]any)[0].(map[string]any)
	assert.Equal(t, "removed", removed["status"], "a removed skill reads removed, not approved")
	assert.NotEqual(t, "approved", removed["status"])

	// the Operator's alone
	for name, hdr := range map[string]map[string]string{"nobody": {"no-dash": "1"}, "an agent's token": {"no-dash": "1", testAgentHeader: "s1"}, "Coral Hub": {"no-dash": "1", tunnel.ViaHeader: "x"}} {
		code, _, _ = list("sid-a", hdr)
		assert.Equal(t, http.StatusForbidden, code, name)
	}
	code, _, _ = list("no-such-session", nil)
	assert.Equal(t, http.StatusNotFound, code)
}

// A skill's newer approved version is said, never swapped in; an agent of any type, asleep, has its list.
func TestALoadedSkillSaysWhenANewerVersionIsApprovedAndASleepingAgentKeepsItsList(t *testing.T) {
	e := newSkillsEnv(t)
	require.NoError(t, e.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "sid-h", AgentType: "hermes", AgentName: "Hermes", WorkingDir: t.TempDir(), IsSleeping: 1}))
	v1, _ := e.publish(map[string]string{"SKILL.md": "---\nname: notes\ndescription: Notes v1.\n---\n# Notes\n"}, store.PublisherOperator)
	code, _ := e.asAgent("sid-h", "hermes-h", "GET", "/api/agent/skills/"+v1.ID)
	require.Equal(t, 200, code)
	_, _ = e.publish(map[string]string{"SKILL.md": "---\nname: notes\ndescription: Notes v2.\n---\n# Notes two\n"}, store.PublisherOperator)

	h := &SessionsHandler{ss: e.ss}
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/live/hermes-h/loaded-skills?session_id=sid-h", nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	w := httptest.NewRecorder()
	h.AgentLoadedSkills(w, req)
	require.Equal(t, 200, w.Code, w.Body.String())
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"), "what an agent loaded is never kept by a cache")
	var out map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	assert.Equal(t, "hermes", out["agent_type"])
	assert.Equal(t, true, out["sleeping"])
	s := out["skills"].([]any)[0].(map[string]any)
	assert.Equal(t, true, s["newer_version"], "the agent read v1; v2 is approved now")
	assert.EqualValues(t, 1, s["version"])
}
