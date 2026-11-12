package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #15951: the command the dialogs show before Launch is the command the launch runs, for every agent type and mode, and it carries no value Coral makes up for the session.
func TestThePreviewIsTheLaunchCommandForEveryAgentTypeAndMode(t *testing.T) {
	t.Setenv("CORAL_DATA_DIR", t.TempDir())
	for _, ty := range []string{at.Claude, at.Codex, at.Agy, at.Pi, at.Hermes, at.Opencode} {
		for _, mode := range []string{"default", "plan", "auto", "bypassPermissions"} {
			t.Run(ty+"/"+mode, func(t *testing.T) {
				p := LaunchParams{WorkingDir: t.TempDir(), CoralDir: t.TempDir(), PermissionMode: mode, Flags: []string{"--model", "m1"}, BoardName: "team", Role: "dev", Prompt: "do the thing", SessionName: "x"}
				if ty == at.Opencode {
					p.OpencodeURL, p.OpencodePasswordFile = "<opencode-server-url>", "<opencode-password-file>"
				}
				want := previewParams(ty, p) // the launch route turns a mode into its flags before it builds
				want.PermissionPreview = false
				want.SessionID = "0b9d8f6e-5a43-4f0d-9a58-3c1f2e7a9b10"
				real, err := GetAgent(ty).LaunchCommand(want)
				require.NoError(t, err)
				got, err := LaunchCommandPreview(ty, p)
				require.NoError(t, err)
				assert.Equal(t, RedactLaunchCommand(real, want.SessionID), got, "the preview is the launch's command, redacted the same way")
				assert.NotEmpty(t, got)
				assert.Contains(t, got, "--model m1", "the person's own choices are shown as they run")
			})
		}
	}
}

func TestThePreviewHidesWhatCoralMakesUpForTheSession(t *testing.T) {
	t.Setenv("CORAL_DATA_DIR", t.TempDir())
	for _, ty := range []string{at.Claude, at.Codex, at.Agy, at.Pi, at.Hermes} {
		got, err := LaunchCommandPreview(ty, LaunchParams{WorkingDir: t.TempDir(), BoardName: "team", Role: "dev", Prompt: "a secret plan", Flags: []string{"--model", "m1"}, CoralPort: 8420, CoralHost: "127.0.0.1"})
		require.NoError(t, err, ty)
		for _, leak := range []string{LaunchTempDir(), "CORAL_SESSION", "CORAL_SUBSCRIBER", "coral-hook-", "a secret plan", "/Applications/", "unset ", "export ", "&&"} {
			assert.NotContains(t, got, leak, ty+": "+got)
		}
	}
	// a session id and a token-shaped value never show, wherever they are
	out := RedactLaunchCommand(`unset X; export CORAL_SESSION_ID='sid-1'; claude --session-id 3f2a1b4c-0000-4000-8000-123456789abc --settings /var/tmp/coral_settings_3f2a1b4c-0000-4000-8000-123456789abc_77.json --x sk-abcdefghijklmnopqrstuvwxyz0123 --y 0123456789abcdef0123456789abcdef0123 -- "$(cat '/var/tmp/coral_prompt_3f2a1b4c-0000-4000-8000-123456789abc_9.txt')"`, "3f2a1b4c-0000-4000-8000-123456789abc")
	assert.Equal(t, `claude --session-id <session-id> --settings <coral-file> --x <redacted> --y <redacted> -- <coral-text>`, out)
}

// The program starts after the last `;` or `&&` that is outside quotes: a flag the person typed with a `;` in it does not cut the line.
func TestTheProgramStartsAfterTheLastTopLevelSeparator(t *testing.T) {
	assert.Equal(t, `claude --append "a; b && c" 'd; e'`, RedactLaunchCommand(`export A='x; y'; export B=1 && claude --append "a; b && c" 'd; e'`, ""))
	assert.Equal(t, `hermes chat`, RedactLaunchCommand(`export H='/h' && if [ ! -f '/h/.p' ]; then echo hi; fi; hermes chat`, ""))
}
