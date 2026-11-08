package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14772 (Security's conditions): an auto_accept run of agy, Antigravity or Gemini is agy's own Auto, never the skip flag; the flag a run names itself stays; and the Hub gate still refuses a Hub-stamped auto_accept
// without the owner's switch and Launch mode.
func TestAnAgyTaskRunWithAutoAcceptNeverCarriesASkipFlag(t *testing.T) {
	const withAuto = "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\ncat <<'EOF'\nUsage of agy:\n  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting\n  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)\nEOF\nfi\nexit 0\n"
	const withoutAuto = "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\ncat <<'EOF'\nUsage of agy:\n  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting\n  --mode                          Set the agent execution mode for this session (accept-edits, plan)\nEOF\nfi\nexit 0\n"
	for _, typ := range []string{"agy", "antigravity", "gemini"} {
		flags := taskRunFlags(typ, "", true)
		assert.Equal(t, "--permission-mode auto", flags, typ)
		assert.NotContains(t, flags, "skip-permissions", typ)
		assert.Equal(t, "--dangerously-skip-permissions", taskRunFlags(typ, "--dangerously-skip-permissions", true), typ+": a skip flag the run names itself stays as written")
		assert.Equal(t, "--permission-mode plan", taskRunFlags(typ, "--permission-mode plan", true), typ+": the run's own mode stays")
		for help, want := range map[string]bool{withAuto: true, withoutAuto: false} {
			fake := stubScript(t, filepath.Join(t.TempDir(), "mock-agy"), help)
			cmd, err := (&agent.AgyAgent{}).LaunchCommand(agent.LaunchParams{CLIPath: fake, Flags: strings.Fields(flags)})
			require.NoError(t, err)
			assert.Equal(t, want, strings.Contains(cmd, "--mode auto"), typ+": --mode auto only for an agy that lists it")
			assert.NotContains(t, cmd, "--dangerously-skip-permissions", typ+": never a skip flag in auto's place")
		}
	}
}

func TestAnAgyAutoAcceptRunThroughTheHubStillNeedsTheOwnersSwitchAndLaunchMode(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "t.db"))
	require.NoError(t, err)
	defer db.Close()
	h := NewTasksHandler(db, &config.Config{})
	ss := store.NewSessionStore(db)
	repo := hubTestGitRepo(t)
	run := func(hub bool, body string) (int, string) {
		r := httptest.NewRequest("POST", "/api/tasks/run", strings.NewReader(body))
		if hub {
			r.Header.Set(tunnel.ViaHeader, "forged")
			stamp(r)
		}
		rec := httptest.NewRecorder()
		h.SubmitTask(rec, r)
		return rec.Code, codeOf(t, rec)
	}
	for _, typ := range []string{"agy", "antigravity", "gemini"} {
		body := `{"prompt":"p","repo_path":` + jsonString(repo) + `,"agent_type":"` + typ + `","auto_accept":true}`
		require.NoError(t, ss.SetSetting(context.Background(), AllowHubAutoAcceptSetting, "false"))
		code, c := run(true, body)
		assert.Equal(t, http.StatusForbidden, code, typ)
		assert.Equal(t, "hub_auto_accept_disabled", c, typ+": the owner's switch is off")
		require.NoError(t, ss.SetSetting(context.Background(), AllowHubAutoAcceptSetting, "true"))
		require.NoError(t, ss.SetSetting(context.Background(), MaxModeSetting, "view"))
		code, c = run(true, body)
		assert.Equal(t, http.StatusForbidden, code, typ)
		assert.Equal(t, "hub_mode_too_low", c, typ+": the Launch mode is not on")
	}
}
