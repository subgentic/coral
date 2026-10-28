package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// #10381 (Desktop mode matrix #10363): what a Codex launch runs with, and what it records, for each pick New agent offers Codex (Default, Plan, Bypass permissions) and for an old saved Accept edits, which the form
// no longer offers (the flags are the ones permission_flags.js sends for each pick). The recorded permission_mode is what the chat's words read (chat_prompt_empty.js).
func TestACodexLaunchRunsAndRecordsWhatThePickSaid(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fakeCodex := filepath.Join(t.TempDir(), "codex")
	require.NoError(t, os.WriteFile(fakeCodex, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Codex), fakeCodex))
	launch := func(body map[string]any) (cmd, stored string) {
		t.Helper()
		body["working_dir"] = rig.workdir
		body["agent_type"] = at.Codex
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b)))
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
	sandboxPair := regexp.MustCompile(`--sandbox (\S+) -a (\S+)`)
	for name, c := range map[string]struct {
		body    map[string]any
		sandbox string // "" none: Codex runs its own default
		stored  string
		bypass  bool
	}{
		"Default":                         {body: map[string]any{"permission_mode": "default"}, stored: "default"},
		"nothing chosen (the saved Auto)": {body: map[string]any{}, sandbox: "workspace-write never", stored: "auto"},
		"Auto":                            {body: map[string]any{"flags": []string{"--sandbox", "workspace-write", "-a", "never"}}, sandbox: "workspace-write never", stored: "auto"},
		"Plan":                            {body: map[string]any{"flags": []string{"--sandbox", "read-only", "-a", "on-request"}}, sandbox: "read-only on-request", stored: "plan"},
		"Bypass":                          {body: map[string]any{"flags": []string{"--dangerously-bypass-approvals-and-sandbox"}}, stored: "bypassPermissions", bypass: true},
		"an old saved Accept edits":       {body: map[string]any{"flags": []string{"--sandbox", "workspace-write", "-a", "on-request"}}, sandbox: "workspace-write on-request", stored: "default"},
	} {
		cmd, stored := launch(c.body)
		got := ""
		if m := sandboxPair.FindStringSubmatch(cmd); m != nil {
			got = m[1] + " " + m[2]
		}
		assert.Equal(t, c.sandbox, got, "%s: the sandbox and approval the command runs", name)
		assert.Equal(t, c.bypass, strings.Contains(cmd, "--dangerously-bypass-approvals-and-sandbox"), "%s: bypass", name)
		assert.Equal(t, c.stored, stored, "%s: the mode recorded for the chat's words and a restart", name)
	}
}
