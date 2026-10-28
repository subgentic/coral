package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// #10362 (critical): a person who picks Default in New agent, or presses Keep Default in "Default mode waits for you", gets a Default agent, never the saved default (Auto) or Claude's own Auto. The launch says
// so with permission_mode "default" (the form sends no flag for Default, which the server could not tell from "nothing chosen"); no other mode can be named this way.
func TestAnExplicitDefaultModeIsNeverWidenedToTheSavedDefaultOrAuto(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fakeClaude := filepath.Join(t.TempDir(), "claude")
	require.NoError(t, os.WriteFile(fakeClaude, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Claude), fakeClaude))
	post := func(body map[string]any) *httptest.ResponseRecorder {
		body["working_dir"] = rig.workdir
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b)))
		return rec
	}
	launch := func(body map[string]any) (cmd, stored string) {
		t.Helper()
		rec := post(body)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		ls, err := rig.ss.GetLiveSession(ctx, res["session_id"].(string))
		require.NoError(t, err)
		require.NotNil(t, ls)
		if ls.PermissionMode != nil {
			stored = *ls.PermissionMode
		}
		rig.term.mu.Lock()
		defer rig.term.mu.Unlock()
		var sent []string
		for name, cmds := range rig.term.sent {
			if strings.Contains(name, res["session_id"].(string)) {
				sent = cmds
			}
		}
		require.NotEmpty(t, sent)
		return sent[len(sent)-1], stored
	}

	for _, saved := range []string{"auto", "bypassPermissions", ""} { // the saved default, and none (Claude's own Auto)
		if saved != "" {
			require.NoError(t, rig.ss.SetSetting(ctx, "default_permission_mode", saved))
		}
		cmd, stored := launch(map[string]any{"agent_type": at.Claude, "permission_mode": "default"})
		assert.Contains(t, cmd, "--permission-mode default", "saved default %q: Default is Default", saved)
		assert.NotContains(t, cmd, "--permission-mode auto")
		assert.NotContains(t, cmd, "dangerously-skip-permissions")
		assert.Equal(t, "default", stored, "saved default %q: what is recorded for a restart", saved)
	}

	// the field names Default and nothing else: any other mode is refused, with nothing launched
	for _, mode := range []string{"auto", "bypassPermissions", "plan", "acceptEdits", "dontAsk", "nonsense"} {
		rec := post(map[string]any{"agent_type": at.Claude, "permission_mode": mode})
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", mode, rec.Body.String())
	}
	// the person's own flags still win over it, as over every mode
	cmd, stored := launch(map[string]any{"agent_type": at.Claude, "permission_mode": "default", "flags": []string{"--permission-mode", "plan"}})
	assert.Contains(t, cmd, "--permission-mode plan")
	assert.Equal(t, "plan", stored)
}
