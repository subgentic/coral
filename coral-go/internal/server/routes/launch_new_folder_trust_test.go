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

// #12882 (QA's walk, odd O1): a person typed a NEW folder at step 1 of the New team wizard, left "Trust this folder" OFF (it says "Coral will not trust <folder> unless this is on"), and Launch team made the folder
// (#12833) and then TRUSTED it anyway, because a folder the launch made counts as trusted without the tick (#11889). In a shared place (/tmp) the trust is refused, which showed a red "Trust this folder was not applied"
// toast and a board note for something the person had not asked for. Only the folder Coral itself suggests is trusted without the tick; a folder the person typed and Coral made follows the switch like any other.

// launchChosen starts a team in dir, a new folder the person chose (create_new_folder), as the person's own dashboard, with the Trust switch as tick says.
func (r *trustRig) launchChosen(t *testing.T, dir string, tick bool) map[string]any {
	t.Helper()
	r.n++
	b, _ := json.Marshal(map[string]any{"board_name": "chosen" + string(rune('a'+r.n)), "new_board": true, "working_dir": dir, "create_new_folder": true, "trust_folder": tick, "agent_type": "claude",
		"agents": []map[string]any{{"name": "A", "agent_type": "claude"}, {"name": "B", "agent_type": "codex"}}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))
	r.h.LaunchTeam(rec, asCaller(callerDashCookie)(req))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func TestANewFolderThePersonTypedIsNotTrustedWhileTheTrustSwitchIsOff(t *testing.T) {
	r := newTrustRig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(r.home, "Code"), 0o755))
	dir := filepath.Join(r.home, "Code", "planner-shop")
	out := r.launchChosen(t, dir, false)
	fi, err := os.Stat(dir)
	require.NoError(t, err, "the folder step 1 promised was made")
	assert.True(t, fi.IsDir())
	assert.Nil(t, out["trust_folder"], "the switch was off: nothing was asked of the CLIs' settings, so the page has nothing to say")
	assert.False(t, r.claudeTrusts(t, dir), "Claude is not told to trust a folder the person left untrusted")
	assert.False(t, r.codexTrusts(t, dir), "nor Codex")
	assert.Empty(t, r.trustNotices(t, out["board"].(string)), "and the board says nothing of trust")
}

func TestANewFolderThePersonTypedIsTrustedWhenTheyTickTheSwitch(t *testing.T) {
	r := newTrustRig(t)
	require.NoError(t, os.MkdirAll(filepath.Join(r.home, "Code"), 0o755))
	dir := filepath.Join(r.home, "Code", "planner-shop")
	out := r.launchChosen(t, dir, true)
	tf := trustOf(t, out)
	assert.ElementsMatch(t, []any{"claude", "codex"}, tf["trusted"].([]any), "the tick is the person's own choice, so it is honoured")
	assert.True(t, r.claudeTrusts(t, dir))
	assert.True(t, r.codexTrusts(t, dir))
}
