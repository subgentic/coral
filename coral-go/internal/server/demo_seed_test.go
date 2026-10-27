package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store/storetest"
)

// A server seeds the demo workflow and its scheduled job by default; with
// CORAL_NO_DEMO_SEED=1 (test servers) it seeds neither, so it never runs a
// real agent on its own (#3136).
func TestDemoSeedCanBeTurnedOff(t *testing.T) {
	for _, tc := range []struct {
		env  string
		want int
	}{{"", 1}, {"1", 0}, {"true", 0}, {"0", 1}} {
		t.Run("CORAL_NO_DEMO_SEED="+tc.env, func(t *testing.T) {
			t.Setenv("CORAL_NO_DEMO_SEED", tc.env)
			cfg := newE2EConfig(t, t.TempDir())
			db, err := storetest.Open(t, cfg.DBPath)
			require.NoError(t, err)
			t.Cleanup(func() { db.Close() })
			stack := newTermStack(t)
			newTestServer(t, cfg, db, stack.backend, stack.terminal)

			ctx := context.Background()
			var jobs, workflows int
			require.NoError(t, db.GetContext(ctx, &jobs, `SELECT COUNT(*) FROM scheduled_jobs WHERE name = 'morning-motivation'`))
			require.NoError(t, db.GetContext(ctx, &workflows, `SELECT COUNT(*) FROM workflows WHERE name = 'daily-motivation'`))
			assert.Equal(t, tc.want, jobs, "seeded scheduled job")
			assert.Equal(t, tc.want, workflows, "seeded workflow")
			// A new install must never run an agent on its own: whatever is seeded is OFF and says it is an example (#6384).
			var enabled int
			require.NoError(t, db.GetContext(ctx, &enabled, `SELECT COUNT(*) FROM scheduled_jobs WHERE enabled != 0`))
			assert.Zero(t, enabled, "a fresh data folder has no enabled scheduled job")
			if tc.want == 1 {
				var jobDesc, wfDesc string
				require.NoError(t, db.GetContext(ctx, &jobDesc, `SELECT description FROM scheduled_jobs WHERE name = 'morning-motivation'`))
				require.NoError(t, db.GetContext(ctx, &wfDesc, `SELECT description FROM workflows WHERE name = 'daily-motivation'`))
				assert.True(t, strings.HasPrefix(jobDesc, "Example"), "the seeded job is marked as an example: %q", jobDesc)
				assert.True(t, strings.HasPrefix(wfDesc, "Example"), "the seeded workflow is marked as an example: %q", wfDesc)
			}
		})
	}
}

// The first-launch screen (#3221) is due on a new install and stays due until the user
// chooses; once welcome_choice is stored, a restart never marks it again. CORAL_NO_WELCOME=1
// (test servers) never marks it.
func TestWelcomePendingOnFirstLaunchOnly(t *testing.T) {
	setting := func(t *testing.T, db interface {
		GetContext(context.Context, any, string, ...any) error
	}, key string) string {
		var v string
		_ = db.GetContext(context.Background(), &v, `SELECT value FROM user_settings WHERE key = ?`, key)
		return v
	}
	for _, tc := range []struct {
		env    string
		chosen bool
		want   string
	}{{"", false, "True"}, {"", true, ""}, {"1", false, ""}} {
		t.Run("CORAL_NO_WELCOME="+tc.env, func(t *testing.T) {
			t.Setenv("CORAL_NO_WELCOME", tc.env)
			cfg := newE2EConfig(t, t.TempDir())
			db, err := storetest.Open(t, cfg.DBPath)
			require.NoError(t, err)
			t.Cleanup(func() { db.Close() })
			if tc.chosen {
				_, err := db.Exec(`INSERT INTO user_settings (key, value) VALUES ('welcome_choice', 'hub')`)
				require.NoError(t, err)
			}
			stack := newTermStack(t)
			newTestServer(t, cfg, db, stack.backend, stack.terminal)
			assert.Equal(t, tc.want, setting(t, db, "welcome_pending"))
			// The dashboard answers the screen; a restart does not bring it back.
			if tc.want == "True" {
				_, err := db.Exec(`INSERT INTO user_settings (key, value) VALUES ('welcome_choice', 'coral'), ('welcome_pending', 'False')
					ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
				require.NoError(t, err)
				newTestServer(t, cfg, db, stack.backend, stack.terminal)
				assert.Equal(t, "False", setting(t, db, "welcome_pending"))
			}
		})
	}
}

// The seeded workflow's last step shows its message as a notification. A workflow step has no agent session token and a curl to
// /api/notifications with no credential, or with the API key, is a 401 (the route takes an agent's token or the Operator): the step
// runs coral-agent notify, which signs the request as the Operator (#9363). This runs the step's own shell command with a stand-in
// coral-agent first on the PATH and checks what the real one would be given: the command, the title, the message of the step
// before it (quotes and all) and the level.
func TestSeededDemoWorkflowNotificationStepRunsCoralAgentNotify(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the step is a POSIX shell command")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh is not installed")
	}
	t.Setenv("CORAL_NO_DEMO_SEED", "")
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	newTestServer(t, cfg, db, stack.backend, stack.terminal)

	var stepsJSON string
	require.NoError(t, db.GetContext(context.Background(), &stepsJSON, `SELECT steps_json FROM workflows WHERE name = 'daily-motivation'`))
	var steps []struct {
		Name    string `json:"name"`
		Type    string `json:"type"`
		Command string `json:"command"`
	}
	require.NoError(t, json.Unmarshal([]byte(stepsJSON), &steps))
	command := ""
	for _, s := range steps {
		if s.Name == "show-notification" && s.Type == "shell" {
			command = s.Command
		}
	}
	require.NotEmpty(t, command, "the seeded workflow has a shell step named show-notification")
	assert.NotContains(t, command, "curl", "a curl to /api/notifications is a 401 in a workflow step")

	bin, out := t.TempDir(), filepath.Join(t.TempDir(), "args")
	stub := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"" + out + "\"\n"
	require.NoError(t, os.WriteFile(filepath.Join(bin, "coral-agent"), []byte(stub), 0o755))
	prev := filepath.Join(t.TempDir(), "prev_stdout")
	message := `Don't "quit" $HOME today.`
	require.NoError(t, os.WriteFile(prev, []byte(message), 0o600))

	cmd := exec.Command("sh", "-c", strings.ReplaceAll(command, "{{prev_stdout}}", prev))
	cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	combined, err := cmd.CombinedOutput()
	require.NoError(t, err, string(combined))

	raw, err := os.ReadFile(out)
	require.NoError(t, err, "the step ran coral-agent")
	args := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	assert.Equal(t, []string{"notify", "--title", "\u2600\ufe0f Daily Motivation", "--message", message, "--level", "success", "--alert"}, args)
}
