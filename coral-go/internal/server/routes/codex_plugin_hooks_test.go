package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
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

// A made-up plugin hook. Codex keeps, as trusted_hash, the sha256 of the compact key-sorted JSON of its identity; the test writes that JSON out by hand, so the code is not checked against itself.
const posthogHookFile = `{"hooks":{"PermissionRequest":[{"matcher":"^mcp__demo__run$","hooks":[{"type":"command","command":"\"${PLUGIN_ROOT}/hooks/demo-gate.sh\"","timeout":5}]}]}}`
const demoIdentity = `{"event_name":"permission_request","hooks":[{"async":false,"command":"\"${PLUGIN_ROOT}/hooks/demo-gate.sh\"","timeout":5,"type":"command"}],"matcher":"^mcp__demo__run$"}`

var posthogTrusted = func() string {
	sum := sha256.Sum256([]byte(demoIdentity))
	return "sha256:" + hex.EncodeToString(sum[:])
}()

func codexFixture(t *testing.T, plugins map[string]string, trust map[string]string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	codex := filepath.Join(home, ".codex")
	var cfg []string
	for name, hookFile := range plugins {
		if hookFile != "" { // "" is a plugin with no hook file
			d := filepath.Join(codex, "plugins", "cache", "m", name, "1.0", "hooks")
			require.NoError(t, os.MkdirAll(d, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(d, "codex-hooks.json"), []byte(hookFile), 0o644))
		}
		cfg = append(cfg, `[plugins."`+name+`@m"]`, `enabled = `+strconv.FormatBool(!strings.HasPrefix(name, "off-"))) // an "off-" plugin is switched off
	}
	for key, h := range trust {
		cfg = append(cfg, `[hooks.state."`+key+`"]`, `trusted_hash = "`+h+`"`, `trusted_content_hash = "sha256:`+strings.Repeat("0", 64)+`"`)
	}
	require.NoError(t, os.MkdirAll(codex, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(codex, "config.toml"), []byte(strings.Join(cfg, "\n")), 0o644))
	return home
}

func TestCodexPluginHookReviewNamesTheChangedPlugin(t *testing.T) {
	key := "posthog@m:hooks/codex-hooks.json:permission_request:0:0"
	// two plugins ship hooks; only posthog's trusted hash is stale
	home := codexFixture(t, map[string]string{"posthog": posthogHookFile, "other": strings.ReplaceAll(posthogHookFile, "demo-gate.sh", "other.sh")},
		map[string]string{key: "sha256:" + strings.Repeat("a", 64), "other@m:hooks/codex-hooks.json:permission_request:0:0": "sha256:x"})
	r := codexPluginHookReview(home)
	assert.Equal(t, []string{"other", "posthog"}, r.Changed, "both hashes differ from the trusted ones")

	// trusted at the hash Codex wrote for this very hook: that plugin is not the one asked about
	trusted := map[string]string{key: posthogTrusted}
	home = codexFixture(t, map[string]string{"posthog": posthogHookFile}, trusted)
	assert.Empty(t, codexPluginHookReview(home).Changed, "the stored hash equals the current hook's: nothing changed")

	// the hook file changed since: the stored hash no longer matches, and only that plugin is named
	quietIdentity := strings.ReplaceAll(demoIdentity, "demo-gate.sh", "quiet.sh")
	quietSum := sha256.Sum256([]byte(quietIdentity))
	home = codexFixture(t, map[string]string{"posthog": strings.ReplaceAll(posthogHookFile, `"timeout":5`, `"timeout":9`), "quiet": strings.ReplaceAll(posthogHookFile, "demo-gate.sh", "quiet.sh")},
		map[string]string{key: posthogTrusted, "quiet@m:hooks/codex-hooks.json:permission_request:0:0": "sha256:" + hex.EncodeToString(quietSum[:])})
	r = codexPluginHookReview(home)
	assert.Equal(t, []string{"posthog"}, r.Changed, "only the plugin whose hook changed is named; quiet is trusted at its own hash")

	// a hook with a key this cannot hash exactly is unsure, not changed
	home = codexFixture(t, map[string]string{"odd": strings.ReplaceAll(posthogHookFile, `"timeout":5`, `"timeout":5,"statusMessage":"x"`)}, nil)
	r = codexPluginHookReview(home)
	assert.Equal(t, []string{"odd"}, r.Unsure)
	assert.Empty(t, r.Changed)
	// a switched-off plugin with a stale hook, and an enabled plugin with no hook file, are named by no one
	home = codexFixture(t, map[string]string{"off-plugin": posthogHookFile, "no-hooks": ""}, nil)
	r = codexPluginHookReview(home)
	assert.Empty(t, r.Changed, "a plugin that is off is not asked about")
	assert.Empty(t, r.Unsure)
	assert.Equal(t, codexPluginHooks{}, codexPluginHookReview(t.TempDir()), "no config: nothing named")
}

func TestCodexHookReviewNote(t *testing.T) {
	exact := codexHookReviewNote(codexPluginHooks{Changed: []string{"posthog"}})
	assert.Contains(t, exact, "not Coral's hooks")
	assert.Contains(t, exact, "The Codex plugin posthog changed its hook")
	assert.NotContains(t, exact, "Most likely", "exact: no hedge")
	assert.Contains(t, exact, "Hooks from the folder or your own Codex settings are not checked here and may be in this review too", "naming a plugin does not clear the others")
	assert.Contains(t, codexHookReviewNote(codexPluginHooks{Unsure: []string{"odd"}}), "are not checked here")
	assert.Contains(t, exact, "outside the sandbox")
	assert.Contains(t, codexHookReviewNote(codexPluginHooks{Changed: []string{"a", "b"}}), "plugins a or b changed their hooks")
	assert.Contains(t, codexHookReviewNote(codexPluginHooks{Unsure: []string{"odd"}}), "Most likely the Codex plugin odd")
	assert.Contains(t, codexHookReviewNote(codexPluginHooks{}), "your own Codex settings")
}

func TestCodexVersionLess(t *testing.T) {
	assert.True(t, codexVersionLess("1.9", "1.10"), "numbers, not text")
	assert.True(t, codexVersionLess("1.3.5", "1.3.12"))
	assert.False(t, codexVersionLess("2.0", "1.10"))
	assert.True(t, codexVersionLess("1.0", "1.0.1"))
}

func TestCodexPluginNamesCannotLeaveTheCacheFolder(t *testing.T) {
	home := codexFixture(t, map[string]string{"posthog": posthogHookFile}, nil)
	cfg := filepath.Join(home, ".codex", "config.toml")
	b, err := os.ReadFile(cfg)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(cfg, append(b, []byte("\n[plugins.\"..@..\"]\nenabled = true\n")...), 0o644))
	assert.Equal(t, []string{"posthog"}, codexPluginHookReview(home).Changed, "a '..' plugin is skipped; the real one is still named")
}
