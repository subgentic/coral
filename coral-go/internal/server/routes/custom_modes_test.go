package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #15950: custom permission modes. The set is saved as a whole and checked as a whole; a launch, a restart and a wake that name "custom:<id>" run the mode's flags in place of a built-in mode's; a mode that
// is gone, or whose stored flags no longer pass, launches as Default with a note, never a failed launch and never a flag that was not checked.

func putModes(t *testing.T, h *SystemHandler, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.PutCustomModes(rec, httptest.NewRequest(http.MethodPut, "/api/custom-modes", strings.NewReader(body)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestCustomModesAreSavedAsAWholeSetAndCheckedAsOne(t *testing.T) {
	h := newSystemHandlerForTest(t)
	// a good set: ids are made by Coral, the risky one is marked
	code, out := putModes(t, h, `{"modes":[{"agent_type":"claude","name":"Plan only","flags":["--permission-mode","plan"]},{"agent_type":"codex","name":"Wide open","flags":["-s","danger-full-access","-a","never"]}]}`)
	require.Equal(t, http.StatusOK, code, out)
	modes := out["modes"].([]any)
	require.Len(t, modes, 2)
	first := modes[0].(map[string]any)
	assert.Regexp(t, `^[a-z0-9]{16}$`, first["id"])
	assert.Equal(t, false, first["risky"])
	assert.Equal(t, true, modes[1].(map[string]any)["risky"], "a mode that turns the prompts off is marked risky")
	// an id that this computer never made is dropped, not kept
	code, out = putModes(t, h, `{"modes":[{"id":"zzzzzzzzzzzzzzzz","agent_type":"claude","name":"Plan only","flags":["--permission-mode=plan"]}]}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.NotEqual(t, "zzzzzzzzzzzzzzzz", out["modes"].([]any)[0].(map[string]any)["id"])
	// a kept row keeps its id
	id := out["modes"].([]any)[0].(map[string]any)["id"].(string)
	code, out = putModes(t, h, `{"modes":[{"id":"`+id+`","agent_type":"claude","name":"Renamed","flags":["--permission-mode=plan"]}]}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, id, out["modes"].([]any)[0].(map[string]any)["id"])
	// one bad row changes nothing and names the row and the field
	code, out = putModes(t, h, `{"modes":[{"agent_type":"claude","name":"ok","flags":["--permission-mode=plan"]},{"agent_type":"claude","name":"bad","flags":["--settings=/tmp/x"]}]}`)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.EqualValues(t, 1, out["row"])
	assert.Equal(t, "flags", out["field"])
	rec := httptest.NewRecorder()
	h.GetCustomModes(rec, httptest.NewRequest(http.MethodGet, "/api/custom-modes", nil))
	var got struct{ Modes []struct{ Name string } }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Modes, 1)
	assert.Equal(t, "Renamed", got.Modes[0].Name, "a refused set leaves the stored one")
	// a typo cannot clear the set
	for _, body := range []string{`{}`, `{"mode":[]}`, `{"modes":null}`, `{"modes":[],"x":1}`, `[]`} {
		code, _ = putModes(t, h, body)
		assert.Equal(t, http.StatusBadRequest, code, body)
	}
	code, _ = putModes(t, h, `{"modes":[]}`)
	assert.Equal(t, http.StatusOK, code, "an empty list clears")
}

func TestAStoredCustomModeIsCheckedAgainWhenRead(t *testing.T) {
	h := newSystemHandlerForTest(t)
	require.NoError(t, h.ss.ReplaceCustomModes(context.Background(), []store.CustomMode{
		{ID: "aaaaaaaaaaaaaaaa", AgentType: "claude", Name: "fine", Flags: []string{"--permission-mode", "plan"}},
		{ID: "bbbbbbbbbbbbbbbb", AgentType: "claude", Name: "edited in the database", Flags: []string{"--settings=/etc/passwd"}},
	}, 0))
	got, err := h.loadCustomModes(context.Background())
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "fine", got[0].Name)
}

type customLaunchRig struct{ *agyTestRig }

func newCustomLaunchRig(t *testing.T) customLaunchRig {
	rig := setupAgyTestRig(t)
	for _, typ := range []string{at.Claude, at.Codex} {
		cli := stubScript(t, filepath.Join(t.TempDir(), "fake-"+typ), "#!/bin/sh\nexit 0\n")
		require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(typ), cli))
	}
	return customLaunchRig{rig}
}

func (r customLaunchRig) launch(t *testing.T, agentType, mode string, agentCaller bool) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"agent_type": agentType, "working_dir": r.workdir, "permission_mode": mode})
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(body))
	if agentCaller {
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "parent", SessionName: "claude-parent"}))
	}
	rec := httptest.NewRecorder()
	r.router.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (r customLaunchRig) save(t *testing.T, modes ...store.CustomMode) {
	t.Helper()
	require.NoError(t, r.ss.ReplaceCustomModes(context.Background(), modes, 0))
}

func TestALaunchInACustomModeRunsItsFlagsPerAgentType(t *testing.T) {
	rig := newCustomLaunchRig(t)
	cases := []struct {
		typ   string
		flags []string
		want  []string
	}{
		{at.Claude, []string{"--permission-mode", "plan"}, []string{"--permission-mode plan"}},
		{at.Codex, []string{"-s", "workspace-write", "-a", "never"}, []string{"workspace-write", "-a never"}},
		{at.Agy, []string{"--mode", "plan"}, []string{"--mode plan"}},
	}
	for i, c := range cases {
		id := strings.Repeat(string(rune('a'+i)), 16)
		rig.save(t, store.CustomMode{ID: id, AgentType: c.typ, Name: "mine", Flags: c.flags})
		code, out := rig.launch(t, c.typ, "custom:"+id, false)
		require.Equal(t, http.StatusOK, code, out)
		cmd := lastSentCommand(rig.term)
		for _, w := range c.want {
			assert.Contains(t, cmd, w, c.typ)
		}
		assert.NotContains(t, cmd, "custom:", c.typ+": the id never reaches the command line")
		assert.Equal(t, "custom:"+id, out["permission_mode"], c.typ)
		assert.Nil(t, out["custom_mode_note"], c.typ)
		ls, err := rig.ss.GetLiveSession(context.Background(), out["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls.PermissionMode)
		assert.Equal(t, "custom:"+id, *ls.PermissionMode, c.typ+": recorded under its own name, so a restart and a wake keep it")
	}
}

func TestALaunchInADeletedOrBrokenCustomModeGoesOnAsDefaultWithANote(t *testing.T) {
	rig := newCustomLaunchRig(t)
	// deleted
	code, out := rig.launch(t, at.Claude, "custom:cccccccccccccccc", false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, out["custom_mode_note"], "deleted")
	assert.Equal(t, "default", out["permission_mode"])
	// a row edited in the database to carry a flag that is not allowed: the argv build checks again, so it never reaches the command
	require.NoError(t, rig.ss.ReplaceCustomModes(context.Background(), []store.CustomMode{{ID: "dddddddddddddddd", AgentType: at.Claude, Name: "edited", Flags: []string{"--settings=/tmp/evil.json"}}}, 0))
	code, out = rig.launch(t, at.Claude, "custom:dddddddddddddddd", false)
	require.Equal(t, http.StatusOK, code, out)
	assert.NotContains(t, lastSentCommand(rig.term), "evil.json")
	assert.NotEmpty(t, out["custom_mode_note"])
	// one made for another kind of agent
	rig.save(t, store.CustomMode{ID: "eeeeeeeeeeeeeeee", AgentType: at.Codex, Name: "codex's", Flags: []string{"-s", "read-only"}})
	code, out = rig.launch(t, at.Claude, "custom:eeeeeeeeeeeeeeee", false)
	require.Equal(t, http.StatusOK, code, out)
	assert.NotContains(t, lastSentCommand(rig.term), "read-only")
	assert.NotEmpty(t, out["custom_mode_note"])
}

func TestAnAgentCannotStartAnotherInACustomMode(t *testing.T) {
	rig := newCustomLaunchRig(t)
	rig.save(t, store.CustomMode{ID: "ffffffffffffffff", AgentType: at.Claude, Name: "wide", Flags: []string{"--dangerously-skip-permissions"}})
	code, _ := rig.launch(t, at.Claude, "custom:ffffffffffffffff", true)
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = rig.launch(t, at.Claude, "bypassPermissions", false)
	assert.Equal(t, http.StatusBadRequest, code, "no other mode name is taken: the form sends flags")
}

func TestARestartKeepsTheCustomMode(t *testing.T) {
	rig := newCustomLaunchRig(t)
	rig.save(t, store.CustomMode{ID: "1234567890abcdef", AgentType: at.Claude, Name: "plan", Flags: []string{"--permission-mode", "plan"}})
	sid := "33333333-4444-5555-6666-777777777777"
	name := naming.SessionName(at.Claude, sid)
	require.NoError(t, rig.term.CreateSession(context.Background(), name, rig.workdir))
	mode := "custom:1234567890abcdef"
	require.NoError(t, rig.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: at.Claude, AgentName: filepath.Base(rig.workdir), WorkingDir: rig.workdir, PermissionMode: &mode}))
	body, _ := json.Marshal(map[string]any{"session_id": sid, "agent_type": at.Claude})
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/restart", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	rig.router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, lastSentCommand(rig.term), "--permission-mode plan", "a restart keeps the custom mode")
	// the mode deleted in between: a restart of another agent in it goes on as Default
	rig.save(t)
	sid2 := "44444444-5555-6666-7777-888888888888"
	name2 := naming.SessionName(at.Claude, sid2)
	require.NoError(t, rig.term.CreateSession(context.Background(), name2, rig.workdir))
	require.NoError(t, rig.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid2, AgentType: at.Claude, AgentName: filepath.Base(rig.workdir), WorkingDir: rig.workdir, PermissionMode: &mode}))
	body2, _ := json.Marshal(map[string]any{"session_id": sid2, "agent_type": at.Claude})
	req = httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name2+"/restart", bytes.NewReader(body2))
	rec = httptest.NewRecorder()
	rig.router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.NotContains(t, lastSentCommand(rig.term), "--permission-mode plan")
}
