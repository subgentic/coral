package routes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// The dialog Codex 0.166 drew for the Operator's PostHog plugin hook (#21208): one hook, the singular, no hook named.
const codexOneHookScreen = `
  Hooks need review
  1 hook is new or changed.
  Hooks can run outside the sandbox after you trust them.

› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

  Press enter to confirm or esc to go back
`

func TestCodexHookReviewIsReadWithOneHook(t *testing.T) {
	s, ok := parsePromptScreenFor(at.Codex, codexOneHookScreen)
	require.True(t, ok, "the singular dialog is read as a prompt")
	assert.True(t, codexHookReview(s))
	assert.True(t, trustDialogOf(s))
	require.Len(t, s.Options, 3)
	assert.Equal(t, "Trust all and continue", s.Options[1].Label)
}

func TestCodexPluginHookNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	codex := filepath.Join(home, ".codex")
	hook := func(market, name string) {
		d := filepath.Join(codex, "plugins", "cache", market, name, "1.3.5", "hooks")
		require.NoError(t, os.MkdirAll(d, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(d, "codex-hooks.json"), []byte("{}"), 0o644))
	}
	hook("posthog", "posthog")
	hook("m", "off-plugin")
	require.NoError(t, os.MkdirAll(filepath.Join(codex, "plugins", "cache", "m", "no-hooks", "1"), 0o755))
	cfg := strings.Join([]string{
		`model = "x"`,
		`[plugins."posthog@posthog"]`,
		`enabled = true`,
		`[plugins."off-plugin@m"]`,
		`enabled = false`,
		`[plugins."no-hooks@m"]`,
		`enabled = true`,
		`[hooks.state."posthog@posthog:hooks/codex-hooks.json:permission_request:0:0"]`,
		`trusted_hash = "sha256:abc"`,
	}, "\n")
	require.NoError(t, os.WriteFile(filepath.Join(codex, "config.toml"), []byte(cfg), 0o644))
	assert.Equal(t, []string{"posthog"}, codexPluginHookNames(home), "enabled plugins that ship a hook file")
	assert.Nil(t, codexPluginHookNames(t.TempDir()), "no config: no names")
}

func TestCodexHookReviewNote(t *testing.T) {
	one := codexHookReviewNote([]string{"posthog"})
	assert.Contains(t, one, "not Coral's hooks")
	assert.Contains(t, one, "Codex plugin posthog")
	assert.Contains(t, one, "outside the sandbox")
	assert.Contains(t, codexHookReviewNote([]string{"a", "b"}), "plugins a or b")
	assert.Contains(t, codexHookReviewNote(nil), "your own Codex settings")
}
