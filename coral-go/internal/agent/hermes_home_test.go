package agent

import (
	"crypto/sha256"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

// treeSum is a hash of every path, mode, size, mtime and content under dir: the person's home must be exactly as it was.
func treeSum(t *testing.T, dir string) [32]byte {
	t.Helper()
	h := sha256.New()
	require.NoError(t, filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		require.NoError(t, err)
		fi, _ := d.Info()
		h.Write([]byte(p + "|" + fi.Mode().String() + "|" + fi.ModTime().String()))
		if fi.Mode().IsRegular() {
			b, _ := os.ReadFile(p)
			h.Write(b)
		}
		return nil
	}))
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

const personConfig = `# my settings
model: some/model
terminal:
  backend: local
hooks:
  pre_llm_call:
    - command: /home/me/own-hook.sh
      timeout: 5
  outbound:
    url: https://example.invalid/hook
hooks_auto_accept: true
`

func seedPerson(t *testing.T, r hermesRigT) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(r.person, "config.yaml"), []byte(personConfig), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(r.person, ".env"), []byte("OPENROUTER_API_KEY=sk-seed\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(r.person, "shell-hooks-allowlist.json"), []byte(`{"approvals":[{"event":"x","command":"/home/me/own-hook.sh"}]}`), 0o600))
}

func readYAML(t *testing.T, p string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(p)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, yaml.Unmarshal(b, &m))
	return m
}

func TestPrepareHermesHomeSeedsFromThePersonAndNeverWritesThere(t *testing.T) {
	r := hermesRig(t)
	seedPerson(t, r)
	before := treeSum(t, r.person)
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	home, err := PrepareHermesHome(r.data, "team-a", r.person, now)
	require.NoError(t, err)
	assert.Equal(t, HermesTeamHome(r.data, "team-a"), home)
	assert.Equal(t, before, treeSum(t, r.person), "the person's home is only read")

	if runtime.GOOS != "windows" {
		for _, p := range []string{filepath.Dir(home), home} {
			fi, err := os.Stat(p)
			require.NoError(t, err)
			assert.Equal(t, os.FileMode(0o700), fi.Mode().Perm(), p)
		}
		for _, f := range []string{".env", "config.yaml", "shell-hooks-allowlist.json"} {
			fi, err := os.Stat(filepath.Join(home, f))
			require.NoError(t, err)
			assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm(), f)
		}
	}
	env, _ := os.ReadFile(filepath.Join(home, ".env"))
	assert.Equal(t, "OPENROUTER_API_KEY=sk-seed\n", string(env))

	cfg := readYAML(t, filepath.Join(home, "config.yaml"))
	assert.Equal(t, "some/model", cfg["model"], "the person's other settings are kept")
	assert.Equal(t, map[string]any{"backend": "local"}, cfg["terminal"])
	assert.NotContains(t, cfg, "hooks_auto_accept")
	hooks, _ := cfg["hooks"].(map[string]any)
	require.Len(t, hooks, len(hermesHookEvents), "Coral's events and no other (the person's outbound hook is gone)")
	for _, ev := range hermesHookEvents {
		entries, _ := hooks[ev].([]any)
		require.Len(t, entries, 1, ev)
		e := entries[0].(map[string]any)
		cmd, _ := e["command"].(string)
		assert.Contains(t, cmd, "--hermes "+ev)
		assert.True(t, strings.HasPrefix(cmd, `"`+filepath.ToSlash(r.tools)+"/coral-hook-agentic-state"), cmd)
		assert.Equal(t, hermesHookTimeout, e["timeout"])
		assert.NotContains(t, cmd, "own-hook")
	}
}

func TestHermesAllowlistHoldsOnlyCoralsEntriesWithTheToolsRealMtime(t *testing.T) {
	r := hermesRig(t)
	seedPerson(t, r)
	mt := time.Date(2026, 10, 1, 8, 30, 15, 123456000, time.UTC)
	require.NoError(t, os.Chtimes(filepath.Join(r.tools, "coral-hook-agentic-state"), mt, mt))
	now := time.Date(2026, 11, 1, 18, 17, 30, 694103000, time.UTC)
	home, err := PrepareHermesHome(r.data, "t", r.person, now)
	require.NoError(t, err)
	b, err := os.ReadFile(filepath.Join(home, "shell-hooks-allowlist.json"))
	require.NoError(t, err)
	var list hermesAllowlist
	require.NoError(t, json.Unmarshal(b, &list))
	require.Len(t, list.Approvals, len(hermesHookEvents))
	cfg := readYAML(t, filepath.Join(home, "config.yaml"))
	for i, ev := range hermesHookEvents {
		a := list.Approvals[i]
		assert.Equal(t, ev, a.Event)
		assert.Equal(t, cfg["hooks"].(map[string]any)[ev].([]any)[0].(map[string]any)["command"], a.Command, "the exact command string of config.yaml")
		assert.Equal(t, "2026-11-01T18:17:30.694103Z", a.ApprovedAt)
		assert.Equal(t, "2026-10-01T08:30:15.123456Z", a.ScriptMtimeAtApproval)
		assert.NotContains(t, a.Command, "own-hook")
	}
	assert.NotContains(t, string(b), "own-hook", "the person's approval is not carried")
}

func TestEachTeamHasItsOwnHomeAndNoNameEscapes(t *testing.T) {
	r := hermesRig(t)
	a, err := PrepareHermesHome(r.data, "team-a", r.person, time.Now())
	require.NoError(t, err)
	b, err := PrepareHermesHome(r.data, "team-b", r.person, time.Now())
	require.NoError(t, err)
	assert.NotEqual(t, a, b)
	for _, team := range []string{"../../evil", "/abs", "a/b", "", "..", strings.Repeat("x", 500), "né\x00"} {
		h := HermesTeamHome(r.data, team)
		rel, err := filepath.Rel(filepath.Join(r.data, hermesHomesFolder), h)
		require.NoError(t, err)
		assert.False(t, strings.ContainsAny(rel, `/\`) || strings.HasPrefix(rel, ".."), "%q -> %s", team, rel)
	}
}

func TestTheEnvIsNeverLoosenedFollowedOrRewritten(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("modes and links")
	}
	r := hermesRig(t)
	seedPerson(t, r)
	home, err := PrepareHermesHome(r.data, "t", r.person, time.Now())
	require.NoError(t, err)
	// the person's key changes later: the team's copy is not rewritten
	require.NoError(t, os.WriteFile(filepath.Join(r.person, ".env"), []byte("OPENROUTER_API_KEY=sk-new\n"), 0o600))
	// a loose mode is brought back
	require.NoError(t, os.Chmod(filepath.Join(home, ".env"), 0o644))
	_, err = PrepareHermesHome(r.data, "t", r.person, time.Now())
	require.NoError(t, err)
	fi, _ := os.Stat(filepath.Join(home, ".env"))
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	b, _ := os.ReadFile(filepath.Join(home, ".env"))
	assert.Equal(t, "OPENROUTER_API_KEY=sk-seed\n", string(b), "never written back")

	// a link in place of the team's .env is refused, and nothing is written through it
	other := filepath.Join(t.TempDir(), "target")
	require.NoError(t, os.WriteFile(other, []byte("keep"), 0o600))
	home2 := HermesTeamHome(r.data, "linked")
	require.NoError(t, os.MkdirAll(home2, 0o700))
	require.NoError(t, os.Symlink(other, filepath.Join(home2, ".env")))
	_, err = PrepareHermesHome(r.data, "linked", r.person, time.Now())
	assert.Error(t, err)
	got, _ := os.ReadFile(other)
	assert.Equal(t, "keep", string(got))

	// a person's .env that is a link seeds nothing
	r2 := hermesRig(t)
	secret := filepath.Join(t.TempDir(), "secret")
	require.NoError(t, os.WriteFile(secret, []byte("TOKEN=linked\n"), 0o600))
	require.NoError(t, os.Symlink(secret, filepath.Join(r2.person, ".env")))
	h3, err := PrepareHermesHome(r2.data, "t", r2.person, time.Now())
	require.NoError(t, err)
	e, _ := os.ReadFile(filepath.Join(h3, ".env"))
	assert.Empty(t, string(e))
}

func TestAHomeThatIsALinkOrAFileIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("links")
	}
	r := hermesRig(t)
	elsewhere := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(r.data, hermesHomesFolder), 0o700))
	require.NoError(t, os.Symlink(elsewhere, HermesTeamHome(r.data, "t")))
	_, err := PrepareHermesHome(r.data, "t", r.person, time.Now())
	assert.Error(t, err)
	entries, _ := os.ReadDir(elsewhere)
	assert.Empty(t, entries, "nothing is written through the link")
	// the homes folder itself a file
	r2 := hermesRig(t)
	require.NoError(t, os.WriteFile(filepath.Join(r2.data, hermesHomesFolder), []byte("x"), 0o600))
	_, err = PrepareHermesHome(r2.data, "t", r2.person, time.Now())
	assert.Error(t, err)
}

// A second launch keeps what the team's home has (a setting changed there) and puts Coral's hooks back; with no hook tool there is no hook entry and no allowlist entry (a bare name would be found through PATH).
func TestAnExistingConfigIsKeptAndTheHooksAreRestored(t *testing.T) {
	r := hermesRig(t)
	home, err := PrepareHermesHome(r.data, "t", r.person, time.Now())
	require.NoError(t, err)
	cfgPath := filepath.Join(home, "config.yaml")
	cfg := readYAML(t, cfgPath)
	cfg["model"] = "chosen/here"
	cfg["hooks"] = map[string]any{"pre_llm_call": []any{map[string]any{"command": "/tmp/evil.sh"}}}
	b, _ := yaml.Marshal(cfg)
	require.NoError(t, os.WriteFile(cfgPath, b, 0o600))
	_, err = PrepareHermesHome(r.data, "t", r.person, time.Now())
	require.NoError(t, err)
	cfg = readYAML(t, cfgPath)
	assert.Equal(t, "chosen/here", cfg["model"])
	assert.NotContains(t, readAll(t, cfgPath), "evil.sh")
	assert.Len(t, cfg["hooks"], len(hermesHookEvents))

	t.Setenv("CORAL_HOOK_DIR", t.TempDir()) // no hook tool there
	_, err = PrepareHermesHome(r.data, "t", r.person, time.Now())
	require.NoError(t, err)
	assert.NotContains(t, readYAML(t, cfgPath), "hooks")
	var list hermesAllowlist
	require.NoError(t, json.Unmarshal([]byte(readAll(t, filepath.Join(home, "shell-hooks-allowlist.json"))), &list))
	assert.Empty(t, list.Approvals)
}

func readAll(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	require.NoError(t, err)
	return string(b)
}

func TestAConfigThatIsNotYAMLStopsTheLaunch(t *testing.T) {
	r := hermesRig(t)
	require.NoError(t, os.WriteFile(filepath.Join(r.person, "config.yaml"), []byte("a: [unclosed\n  - : :\n"), 0o600))
	_, err := GetAgent("hermes").LaunchCommand(LaunchParams{SessionID: "s", BoardName: "t"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Hermes home")
	r2 := hermesRig(t)
	require.NoError(t, os.WriteFile(filepath.Join(r2.person, "config.yaml"), []byte("- a\n- b\n"), 0o600))
	_, err = GetAgent("hermes").LaunchCommand(LaunchParams{SessionID: "s", BoardName: "t"})
	assert.Error(t, err)
}

// The launch line runs Hermes in the team's home, never the person's, and never accepts hooks wholesale.
func TestTheLaunchLineNamesTheTeamsHome(t *testing.T) {
	r := hermesRig(t)
	cmd, err := GetAgent("hermes").LaunchCommand(LaunchParams{SessionID: "s", BoardName: "team-a", CoralDir: r.data})
	require.NoError(t, err)
	home := HermesTeamHome(r.data, "team-a")
	assert.Contains(t, cmd, "HERMES_HOME="+"'"+home+"'")
	assert.NotContains(t, cmd, r.person)
	assert.NotContains(t, cmd, "HERMES_ACCEPT_HOOKS")
	assert.NotContains(t, cmd, "--accept-hooks")
	_, err = os.Stat(filepath.Join(home, "config.yaml"))
	assert.NoError(t, err)
}
