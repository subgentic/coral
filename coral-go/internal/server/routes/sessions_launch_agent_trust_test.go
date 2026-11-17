package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// launchAgent starts one agent of typ in dir (made by the launch when create is true), as caller, through POST /api/sessions/launch.
func (r *trustRig) launchAgent(t *testing.T, typ, dir string, create, tick bool, as func(*http.Request) *http.Request) map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"working_dir": dir, "create_dir": create, "trust_folder": tick, "agent_type": typ, "permission_mode": "default"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))
	r.h.Launch(rec, as(req))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

// #19176: a New agent launch trusts its folder under the team rule, for the one agent type it starts.
func TestANewAgentInAFolderTheLaunchMadeTrustsItForItsType(t *testing.T) {
	for typ, trusts := range map[string]func(*trustRig, *testing.T, string) bool{
		"claude": func(r *trustRig, t *testing.T, p string) bool { return r.claudeTrusts(t, p) },
		"codex":  func(r *trustRig, t *testing.T, p string) bool { return r.codexTrusts(t, p) },
		"agy":    func(r *trustRig, t *testing.T, p string) bool { return r.agyTrusts(t, p) },
	} {
		t.Run(typ, func(t *testing.T) {
			r := newTrustRig(t)
			dir := filepath.Join(r.home, "Coral", "proj-"+typ)
			out := r.launchAgent(t, typ, dir, true, false, asCaller(callerDashCookie))
			tf := trustOf(t, out)
			assert.Equal(t, []any{typ}, tf["trusted"].([]any))
			assert.True(t, trusts(r, t, dir), "the entry the CLI reads is there")
		})
	}
}

func TestANewAgentInAnExistingFolderIsTrustedOnlyWithTheTick(t *testing.T) {
	r := newTrustRig(t)
	dir := filepath.Join(r.home, "Code", "app")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	out := r.launchAgent(t, "agy", dir, false, false, asCaller(callerDashCookie))
	assert.Nil(t, out["trust_folder"], "nothing was asked")
	assert.False(t, r.agyTrusts(t, dir))
	out = r.launchAgent(t, "agy", dir, false, true, asCaller(callerDashCookie))
	assert.Equal(t, []any{"agy"}, trustOf(t, out)["trusted"].([]any))
	assert.True(t, r.agyTrusts(t, dir))
}

func TestANewAgentLaunchTrustsNothingForACallerThatIsNotTheDashboard(t *testing.T) {
	r := newTrustRig(t)
	dir := filepath.Join(r.home, "Code", "app2")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	out := r.launchAgent(t, "claude", dir, false, true, asCaller(callerAPIKey))
	assert.NotEmpty(t, trustOf(t, out)["refused"])
	assert.False(t, r.claudeTrusts(t, dir))
}

func TestANewAgentTickedInHomeOrADirectChildOfItIsNotTrusted(t *testing.T) {
	r := newTrustRig(t)
	child := filepath.Join(r.home, "direct")
	require.NoError(t, os.MkdirAll(child, 0o755))
	out := r.launchAgent(t, "claude", child, false, true, asCaller(callerDashCookie))
	assert.NotEmpty(t, trustOf(t, out)["refused"])
	assert.False(t, r.claudeTrusts(t, child))
}
