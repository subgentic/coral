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

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #12833: the New team wizard accepted a new folder at step 1 and Launch refused it with "Folder not found". Now a person who was told Coral makes it has it made, at launch, inside the folder they chose, and an
// agent or a Hub request cannot ask for it.
func newFolderTeam(t *testing.T) (*SessionsHandler, func(dir string, create bool, mod func(*http.Request)) (int, map[string]any)) {
	t.Helper()
	cfg := config.Load(t.TempDir())
	_, h, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	stubCLIPaths(t, ss)
	require.NoError(t, ss.SetSetting(context.Background(), "cli_path_claude", filepath.Join(t.TempDir(), "no-such-cli")))
	n := 0
	return h, func(dir string, create bool, mod func(*http.Request)) (int, map[string]any) {
		n++
		body := map[string]any{"board_name": "nf-team-" + string(rune('a'+n)), "working_dir": dir, "agent_type": "claude", "agents": []map[string]any{{"name": "A", "prompt": "x"}}}
		if create {
			body["create_new_folder"] = true
		}
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))
		if mod != nil {
			mod(req)
		}
		rec := httptest.NewRecorder()
		h.LaunchTeam(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
}

func TestATeamLaunchMakesTheNewFolderTheWizardSaidItWould(t *testing.T) {
	_, launch := newFolderTeam(t)
	parent := t.TempDir()
	dir := filepath.Join(parent, "planner-shop")
	code, out := launch(dir, false, nil)
	raw, _ := json.Marshal(out)
	assert.GreaterOrEqual(t, code, 400, "without the person's request the folder is not made: %s", raw)
	assert.Contains(t, string(raw), "directory not found", "the report the first-time user hit")
	_, err := os.Stat(dir)
	assert.Error(t, err, "nothing was made")
	code, out = launch(dir, true, nil)
	raw, _ = json.Marshal(out)
	assert.NotContains(t, string(raw), "directory not found", "the folder was made and the launch went on: %d %s", code, raw)
	fi, err := os.Stat(dir)
	require.NoError(t, err)
	assert.True(t, fi.IsDir())
}

func TestANewFolderIsMadeOnlyForAPersonAtThisComputer(t *testing.T) {
	h, launch := newFolderTeam(t)
	parent := t.TempDir()
	dir := filepath.Join(parent, "viahub")
	code, out := launch(dir, true, func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, "1") })
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Contains(t, out["error"], "only when a person asks")
	_, err := os.Stat(dir)
	assert.Error(t, err, "a request through Coral Hub made nothing")
	agentDir := filepath.Join(parent, "byagent")
	code, out = launch(agentDir, true, func(r *http.Request) {
		*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid", SessionName: "claude-sid"}))
	})
	assert.GreaterOrEqual(t, code, 400, "%v", out)
	_, err = os.Stat(agentDir)
	assert.Error(t, err, "an agent's request made nothing")
	_ = h
	// a path outside the shape is refused whoever asks, and nothing is made
	bad := parent + string(filepath.Separator) + "a" + string(filepath.Separator) + ".." + string(filepath.Separator) + "escaped"
	code, out = launch(bad, true, nil)
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	_, err = os.Stat(filepath.Join(parent, "escaped"))
	assert.Error(t, err)
}
