package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11093/#11102 slice 1: the Pi extension is embedded, written per launch at 0600, digest-checked, started with -e, and changes nothing under ~/.pi.

func piToolsDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	name := "coral-hook-agentic-state"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"), 0o755))
	t.Setenv(HookDirEnv, dir)
	return filepath.Join(dir, name)
}

func piLaunch(t *testing.T, extra func(*LaunchParams)) string {
	t.Helper()
	p := LaunchParams{SessionID: "11111111-2222-3333-4444-555555555555", SessionName: "pi-11111111-2222-3333-4444-555555555555", CoralDir: t.TempDir(), WorkingDir: t.TempDir(), Role: "Worker", Prompt: "hello"}
	if extra != nil {
		extra(&p)
	}
	cmd, err := (&PiAgent{}).LaunchCommand(p)
	require.NoError(t, err)
	return cmd
}

var piExtArg = regexp.MustCompile(`-e '?([^' ]*coral_pi_ext_[^' ]+\.js)'?`)

func TestPiLaunchStartsPiWithCoralsExtension(t *testing.T) {
	hook := piToolsDir(t)
	cmd := piLaunch(t, nil)
	m := piExtArg.FindStringSubmatch(cmd)
	require.NotNil(t, m, "the launch has -e <the extension file>: %s", cmd)
	assert.NotContains(t, cmd, "--no-extensions", "the person's own extensions keep loading (Security's ruling)")
	assert.NotContains(t, cmd, "-ne ")
	fi, err := os.Stat(m[1])
	require.NoError(t, err)
	if runtime.GOOS != "windows" {
		assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm(), "the extension file is 0600")
	}
	raw, err := os.ReadFile(m[1])
	require.NoError(t, err)
	src := string(raw)
	assert.NotContains(t, src, "__CORAL_PI_CONFIG__", "the configuration is written in")
	cfgText := regexp.MustCompile(`const CONFIG = (\{.*\});`).FindStringSubmatch(src)
	require.NotNil(t, cfgText, "the configuration is a JSON object literal")
	var cfg struct {
		HookBin  string   `json:"hookBin"`
		EnvNames []string `json:"envNames"`
		Rev      int      `json:"rev"`
	}
	require.NoError(t, json.Unmarshal([]byte(cfgText[1]), &cfg))
	assert.Equal(t, hook, cfg.HookBin)
	assert.Equal(t, piHookEnvNames, cfg.EnvNames)
	assert.Equal(t, PiExtensionRev, cfg.Rev)
	assert.Equal(t, strings.Replace(piExtensionSource, piConfigPlaceholder, cfgText[1], 1), src, "the file is the embedded source and the configuration, nothing else")
}

func TestPiLaunchWithoutAHookProgramHasNoExtension(t *testing.T) {
	t.Setenv(HookDirEnv, t.TempDir()) // a tools folder with no hook program
	assert.NotContains(t, piLaunch(t, nil), "coral_pi_ext_", "no program to start: no extension (the session-file state stands alone)")
	dir := t.TempDir() // a hook program that is a link is not taken
	target := filepath.Join(dir, "elsewhere")
	require.NoError(t, os.WriteFile(target, []byte("x"), 0o755))
	if err := os.Symlink(target, filepath.Join(dir, "coral-hook-agentic-state")); err == nil && runtime.GOOS != "windows" {
		t.Setenv(HookDirEnv, dir)
		assert.NotContains(t, piLaunch(t, nil), "coral_pi_ext_", "a link is not the tools folder's own program")
	}
}

func TestPiExtensionDigestIsPinnedAndCheckedBeforeUse(t *testing.T) {
	assert.Equal(t, piExtensionDigest, sha256Hex(piExtensionSource), "pi_extension/coral_pi.js changed: review it, then update piExtensionDigest")
	hook := piToolsDir(t)
	assert.NotEmpty(t, piExtensionContent(hook))
	assert.Empty(t, piExtensionContent(""), "no program, no content")
	saved := piExtensionSource
	defer func() { piExtensionSource = saved }()
	piExtensionSource = saved + "\n// changed"
	assert.Empty(t, piExtensionContent(hook), "a source that is not the reviewed one is never written")
}

// A hook program whose path holds quotes, a newline, a line separator or a comment end stays a JSON string: the file is still the same code with a different literal.
func TestPiExtensionConfigNeverBecomesCode(t *testing.T) {
	for _, path := range []string{`/tmp/a"b`, "/tmp/a\nb", "/tmp/a\u2028b", "/tmp/*/ evil(); /*", `/tmp/a\"; process.exit(1); //`, "/tmp/</script>"} {
		src := piExtensionContent(path)
		require.NotEmpty(t, src, path)
		m := regexp.MustCompile(`(?m)^const CONFIG = (\{.*\});$`).FindStringSubmatch(src)
		require.NotNil(t, m, "the config stays on one line for %q", path)
		var cfg struct {
			HookBin string `json:"hookBin"`
		}
		require.NoError(t, json.Unmarshal([]byte(m[1]), &cfg), path)
		assert.Equal(t, path, cfg.HookBin)
		assert.Equal(t, 1, strings.Count(src, "const CONFIG ="), "only the one configuration")
	}
}

// Notification events only (Security's "never block"): the extension registers exactly these and none of Pi's gates.
func TestPiExtensionRegistersNotificationEventsOnly(t *testing.T) {
	want := []string{"session_start", "agent_start", "tool_execution_start", "tool_execution_end", "agent_end", "agent_settled", "session_shutdown"}
	m := regexp.MustCompile(`const EVENTS = \[([^\]]*)\]`).FindStringSubmatch(piExtensionSource)
	require.NotNil(t, m)
	var got []string
	for _, e := range regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(m[1], -1) {
		got = append(got, e[1])
	}
	assert.Equal(t, want, got)
	assert.Equal(t, 1, strings.Count(piExtensionSource, "pi.on("), "one registration site, over EVENTS")
	for _, gate := range []string{"tool_call", "tool_result", "input", "before_agent_start", "context", "context_with_system", "before_provider_request", "before_provider_headers", "message_end", "turn_end", "agent_before_settle", "user_bash", "session_before_switch", "session_before_fork", "session_before_compact"} {
		for _, g := range regexp.MustCompile(`['"]`+gate+`['"]`).FindAllString(regexp.MustCompile(`(?m)//.*$`).ReplaceAllString(piExtensionSource, ""), -1) {
			t.Errorf("the extension names the gate event %s (%s): it registers notification events only", gate, g)
		}
	}
	code := regexp.MustCompile(`(?m)//.*$`).ReplaceAllString(piExtensionSource, "") // the comments say what it never does; only the code is checked
	for _, banned := range []string{"await ", "async ", "execSync", "spawnSync", "child_process.exec(", "require('node:net')", "require('node:http')", "require('node:https')", "fetch(", "writeFile", "appendFile", "XMLHttpRequest", "eval(", "new Function"} {
		assert.NotContains(t, code, banned, "the extension never %s", banned)
	}
	sorted := append([]string{}, want...)
	sort.Strings(sorted)
	assert.Len(t, sorted, 7)
}

// Nothing is written under ~/.pi (or Pi's own folder) by a launch (Security's condition 6).
func TestPiLaunchWritesNothingUnderThePersonsPiFolder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(home, "agentdir"))
	piToolsDir(t)
	piLaunch(t, nil)
	_, err := os.Stat(filepath.Join(home, ".pi"))
	assert.True(t, os.IsNotExist(err), "no ~/.pi was made")
	_, err = os.Stat(filepath.Join(home, "agentdir"))
	assert.True(t, os.IsNotExist(err), "Pi's own agent folder was not touched")
}
