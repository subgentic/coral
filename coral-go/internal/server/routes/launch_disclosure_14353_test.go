package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// ackLaunchDisclosure records the owner's acknowledgement of the current notice, for the tests of other things that start a dashboard launch in the new default.
func ackLaunchDisclosure(t *testing.T, ss *store.SessionStore) {
	t.Helper()
	require.NoError(t, ss.SetSetting(context.Background(), launchDisclosureAckSetting, `{"id":"`+LaunchDisclosureID+`","at":"2026-01-01T00:00:00Z"}`))
}

type discRig struct {
	t    *testing.T
	rig  *agyTestRig
	n    int
	sent func() int
}

func newDiscRig(t *testing.T) *discRig {
	rig := setupAgyTestRig(t)
	fake := stubScript(t, filepath.Join(t.TempDir(), "mock-claude"), "#!/bin/sh\nexit 0\n")
	require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(at.Claude), fake))
	require.NoError(t, rig.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "11111111-2222-4333-8444-555555555555", AgentType: "claude", AgentName: "parent", WorkingDir: rig.workdir}))
	return &discRig{t: t, rig: rig, sent: func() int { return len(rig.term.sentCommands()) }}
}

func withKind(kind string) func(*http.Request) *http.Request {
	return func(r *http.Request) *http.Request { return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, kind)) }
}

func asAgentToken(r *http.Request) *http.Request {
	const sid = "11111111-2222-4333-8444-555555555555"
	return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid, SessionName: "claude-" + sid}))
}

func (d *discRig) call(handler http.HandlerFunc, method, path string, body any, mod func(*http.Request) *http.Request) (int, map[string]any) {
	d.t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, bytes.NewReader(b))
	if mod != nil {
		req = mod(req)
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (d *discRig) launch(mod func(*http.Request) *http.Request, extra map[string]any) (int, map[string]any) {
	d.n++
	body := map[string]any{"agent_type": at.Claude, "working_dir": d.rig.workdir}
	for k, v := range extra {
		body[k] = v
	}
	return d.call(d.rig.h.Launch, http.MethodPost, "/api/sessions/launch", body, mod)
}

func (d *discRig) team(mod func(*http.Request) *http.Request, member map[string]any) (int, map[string]any) {
	d.n++
	body := map[string]any{"board_name": "disc" + string(rune('a'+d.n)), "new_board": true, "working_dir": d.rig.workdir, "agent_type": at.Claude, "agents": []any{member}}
	return d.call(d.rig.h.LaunchTeam, http.MethodPost, "/api/sessions/launch-team", body, mod)
}

func TestTheLaunchNoticeIsReadAndAcknowledgedOnlyByTheOwner(t *testing.T) {
	d := newDiscRig(t)
	h := d.rig.h
	code, v := d.call(h.GetLaunchDisclosure, "GET", "/api/launch-disclosure", nil, nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, LaunchDisclosureID, v["id"])
	assert.Equal(t, LaunchDisclosureText, v["text"])
	assert.Equal(t, false, v["seen"])
	assert.Contains(t, v["text"], "run as you, with every file you can reach")
	assert.NotContains(t, v["text"], "data folder", "no claim that Coral fences its data folder")

	// an agent's token can neither read, acknowledge nor clear it; nothing is stored
	for name, hd := range map[string]http.HandlerFunc{"read": h.GetLaunchDisclosure, "ack": h.AckLaunchDisclosure, "clear": h.ClearLaunchDisclosure} {
		code, out := d.call(hd, "POST", "/x", map[string]string{"id": LaunchDisclosureID}, asAgentToken)
		assert.Equal(t, http.StatusForbidden, code, name)
		assert.Equal(t, "forbidden_for_agent", out["code"], name)
	}
	_, v = d.call(h.GetLaunchDisclosure, "GET", "/x", nil, nil)
	assert.Equal(t, false, v["seen"], "an agent's tries recorded nothing")

	// a stale id is refused; the current one is recorded with its time
	code, out := d.call(h.AckLaunchDisclosure, "POST", "/x", map[string]string{"id": "old-words"}, nil)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "stale_disclosure", out["code"])
	code, v = d.call(h.AckLaunchDisclosure, "POST", "/x", map[string]string{"id": LaunchDisclosureID}, nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, v["seen"])
	assert.NotEmpty(t, v["acknowledged_at"])
	// the record holds only the id and the time, and is hidden from the settings list
	raw, err := d.rig.ss.GetSettings(context.Background())
	require.NoError(t, err)
	var rec map[string]string
	require.NoError(t, json.Unmarshal([]byte(raw[launchDisclosureAckSetting]), &rec))
	assert.Len(t, rec, 2)
	assert.True(t, sensitiveKeys[launchDisclosureAckSetting], "GET /api/settings never lists it")
	// only the owner takes it back
	_, v = d.call(h.ClearLaunchDisclosure, "DELETE", "/x", nil, nil)
	assert.Equal(t, false, v["seen"])
	// a record for other words does not count
	require.NoError(t, d.rig.ss.SetSetting(context.Background(), launchDisclosureAckSetting, `{"id":"old-words","at":"2020-01-01T00:00:00Z"}`))
	_, v = d.call(h.GetLaunchDisclosure, "GET", "/x", nil, nil)
	assert.Equal(t, false, v["seen"])
}

// A launch from the dashboard's own dialog that would use the new default waits for the acknowledgement: 409 with the notice, nothing started; then it goes. One that names its mode does not wait.
func TestADialogLaunchWaitsForTheNoticeBeforeTheNewDefault(t *testing.T) {
	d := newDiscRig(t)
	dialog := withKind(callerDashCookie)
	for route, run := range map[string]func() (int, map[string]any){
		"launch": func() (int, map[string]any) { return d.launch(dialog, nil) },
		"team":   func() (int, map[string]any) { return d.team(dialog, map[string]any{"name": "A"}) },
	} {
		before := d.sent()
		code, out := run()
		require.Equal(t, http.StatusConflict, code, "%s: %v", route, out)
		assert.Equal(t, launchDisclosureRequired, out["code"], route)
		disc, _ := out["disclosure"].(map[string]any)
		assert.Equal(t, LaunchDisclosureText, disc["text"], route)
		assert.Equal(t, before, d.sent(), "%s: nothing started", route)
	}
	// naming a mode is not the new default: no wait
	code, out := d.launch(dialog, map[string]any{"permission_mode": "default"})
	assert.Equal(t, http.StatusOK, code, "%v", out)
	code, out = d.team(dialog, map[string]any{"name": "B", "permission_mode": "default"})
	assert.Equal(t, http.StatusOK, code, "%v", out)
	// after the owner's acknowledgement the same payloads start, in the new default
	code, _ = d.call(d.rig.h.AckLaunchDisclosure, "POST", "/x", map[string]string{"id": LaunchDisclosureID}, nil)
	require.Equal(t, http.StatusOK, code)
	code, out = d.launch(dialog, nil)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "auto", out["permission_mode"])
	assert.NotContains(t, out, "launch_disclosure", "seen: not repeated")
	code, out = d.team(dialog, map[string]any{"name": "C"})
	require.Equal(t, http.StatusOK, code, "%v", out)
}

// The paths with no person at the screen never block and never count as seen: they answer with the mode used, where to lower it and, while unseen, the notice.
func TestNonDialogLaunchesNeverBlockAndAnswerWithTheModeAndHowToLowerIt(t *testing.T) {
	d := newDiscRig(t)
	for name, mod := range map[string]func(*http.Request) *http.Request{
		"api key":      withKind(callerAPIKey),
		"cli (signed)": withKind(callerCLISigned),
		"no kind":      nil,
		"agent token":  asAgentToken,
	} {
		code, out := d.launch(mod, nil)
		require.Equal(t, http.StatusOK, code, "%s launch: %v", name, out)
		assert.NotEmpty(t, out["permission_mode"], name)
		assert.Equal(t, PermissionLoweringText, out["permission_lowering"], name)
		disc, _ := out["launch_disclosure"].(map[string]any)
		assert.Equal(t, LaunchDisclosureText, disc["text"], "%s: the notice rides in the answer while unseen", name)
		code, out = d.team(mod, map[string]any{"name": "M"})
		require.Equal(t, http.StatusOK, code, "%s team: %v", name, out)
		assert.Equal(t, PermissionLoweringText, out["permission_lowering"], name)
		assert.NotNil(t, out["launch_disclosure"], name)
		agents, _ := out["agents"].([]any)
		require.Len(t, agents, 1)
		assert.NotEmpty(t, agents[0].(map[string]any)["permission_mode"], name)
	}
	// none of them counted as the owner having read it
	_, v := d.call(d.rig.h.GetLaunchDisclosure, "GET", "/x", nil, nil)
	assert.Equal(t, false, v["seen"])
	// an agent's launch is still capped (MUST 1): its row records no mode, so the member is Default, not Auto
	_, out := d.launch(asAgentToken, nil)
	assert.Equal(t, "default", out["permission_mode"])
}

// The dashboard's forms write their shipped Auto as the CLI's own flags, so a dialog launch that carries a mode that skips the prompts waits for the notice too (Frontend Dev's finding on #14353):
// the server decides, not the page. Flags that keep asking, an explicit Default, and a saved default do not wait.
func TestADialogLaunchThatWritesItsShippedModeAsFlagsStillWaitsForTheNotice(t *testing.T) {
	d := newDiscRig(t)
	dialog := withKind(callerDashCookie)
	for _, flags := range [][]string{{"--permission-mode", "auto"}, {"--permission-mode=bypassPermissions"}, {"--dangerously-skip-permissions"}} {
		before := d.sent()
		code, out := d.launch(dialog, map[string]any{"flags": flags})
		require.Equal(t, http.StatusConflict, code, "%v: %v", flags, out)
		assert.Equal(t, launchDisclosureRequired, out["code"], "%v", flags)
		code, out = d.team(dialog, map[string]any{"name": "A", "flags": flags})
		require.Equal(t, http.StatusConflict, code, "team %v: %v", flags, out)
		assert.Equal(t, before, d.sent(), "%v: nothing started", flags)
	}
	// the team's own flags count for a member that has none
	d.n++
	code, out := d.call(d.rig.h.LaunchTeam, http.MethodPost, "/api/sessions/launch-team", map[string]any{"board_name": "disc-teamflags", "new_board": true, "working_dir": d.rig.workdir, "agent_type": at.Claude,
		"flags": []string{"--permission-mode", "auto"}, "agents": []any{map[string]any{"name": "A"}}}, dialog)
	require.Equal(t, http.StatusConflict, code, "%v", out)
	// modes that ask, an explicit Default and a saved default do not wait
	code, out = d.launch(dialog, map[string]any{"flags": []string{"--permission-mode", "default"}})
	assert.Equal(t, http.StatusOK, code, "%v", out)
	code, out = d.launch(dialog, map[string]any{"permission_mode": "default"})
	assert.Equal(t, http.StatusOK, code, "%v", out)
	require.NoError(t, d.rig.ss.SetSetting(context.Background(), "default_permission_mode", "default"))
	code, out = d.launch(dialog, map[string]any{"flags": []string{"--permission-mode", "auto"}})
	assert.Equal(t, http.StatusOK, code, "the owner saved a default of their own: nothing is shipped to them unannounced: %v", out)
}

// Security's condition B on #14333: the notice names Hermes Bypass and the Bypass and Full access exception for the checks and Codex's folder.
func TestTheLaunchNoticeNamesHermesBypassAndTheBypassException(t *testing.T) {
	assert.Contains(t, LaunchDisclosureText, "Hermes, OpenCode and Pi agents run with no such checks at all, and so does any agent you start in Bypass or with Full access (Codex then leaves its folder too).")
	assert.Equal(t, "full-permissions-3", LaunchDisclosureID, "new words, new id: an older acknowledgement no longer counts")
}

// Security's SHOULD on #14353: only "default" names a mode. Any other non-empty permission_mode is dropped by the launch, so it counts as none in each of the three places that decide the gate.
func TestOnlyDefaultCountsAsNamingAModeForTheNoticeGate(t *testing.T) {
	none := map[string]string{}
	// launchDefaultSkips
	assert.True(t, launchDefaultSkips(at.Claude, nil, "", none))
	assert.True(t, launchDefaultSkips(at.Claude, nil, "auto", none), "another value is as good as none")
	assert.True(t, launchDefaultSkips(at.Claude, nil, "bypassPermissions", none))
	assert.False(t, launchDefaultSkips(at.Claude, nil, "default", none), "only default names a mode")
	// memberDefaultSkips
	body := launchTeamRequest{AgentType: at.Claude}
	assert.True(t, memberDefaultSkips(body, launchTeamAgent{Name: "A", PermissionMode: "auto"}, none, at.Claude, nil))
	assert.False(t, memberDefaultSkips(body, launchTeamAgent{Name: "A", PermissionMode: "default"}, none, at.Claude, nil))
	// teamUsesNewDefault
	assert.True(t, teamUsesNewDefault(launchTeamRequest{AgentType: at.Claude, Agents: []launchTeamAgent{{Name: "A", PermissionMode: "bypassPermissions"}}}, none))
	assert.False(t, teamUsesNewDefault(launchTeamRequest{AgentType: at.Claude, Agents: []launchTeamAgent{{Name: "A", PermissionMode: "default"}}}, none))
	// every prompt-skipping default is covered, not only Claude's: Auto, Codex never-ask, Hermes and OpenCode Bypass, agy yolo written as flags
	for _, typ := range []string{at.Claude, at.Codex, at.Hermes, at.Opencode} {
		assert.True(t, launchDefaultSkips(typ, nil, "", none), typ)
	}
	assert.True(t, launchDefaultSkips(at.Agy, []string{"--dangerously-skip-permissions"}, "", none), "agy yolo as flags")
}
