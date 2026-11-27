package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

// #340: a CLI that is on PATH only through a folder Windows will not open is refused with one clear line, in the launch, and shown by the CLI-paths check before a launch.
func TestLaunchRefusesAnUntrustedMountPathWithTheFix(t *testing.T) {
	old := agent.UntrustedMountDir
	t.Cleanup(func() { agent.UntrustedMountDir = old })
	agent.UntrustedMountDir = func(string) (string, bool) { return `C:\Users\x\AppData\Local\Programs\OpenAI\Codex\bin`, true }
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
	t.Setenv("LOCALAPPDATA", t.TempDir()) // the common places (Codex's standalone folder is one, #582): not this machine's own install
	t.Setenv("APPDATA", t.TempDir())

	_, err := resolveLaunchCLI("codex", "")
	var um *agent.CLIUntrustedMountError
	require.ErrorAs(t, err, &um)
	answer, ok := cliPathRefusal(context.Background(), err)
	require.True(t, ok)
	rec := httptest.NewRecorder()
	answer(rec)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Contains(t, rec.Body.String(), "cli_untrusted_mount")
	assert.Contains(t, rec.Body.String(), "Providers") // the ">" is JSON-escaped
	assert.Contains(t, rec.Body.String(), "Codex")

	// An ordinary missing CLI keeps the install answer.
	agent.UntrustedMountDir = func(string) (string, bool) { return "", false }
	_, err = resolveLaunchCLI("codex", "")
	require.Error(t, err)
	assert.NotErrorAs(t, err, &um)
	assert.Contains(t, err.Error(), "CLI not found. Install it:")
}

func TestCLICheckShowsAnUntrustedMountBeforeALaunch(t *testing.T) {
	prevLook, prevCommon, prevMount := cliLookPath, cliCommonPath, agent.UntrustedMountDir
	t.Cleanup(func() { cliLookPath, cliCommonPath, agent.UntrustedMountDir = prevLook, prevCommon, prevMount })
	cliLookPath = func(string) (string, error) { return "", assert.AnError }
	cliCommonPath = func(string) string { return "" }
	agent.UntrustedMountDir = func(string) (string, bool) { return `C:\Codex\bin`, true }
	h := newSystemHandlerForTest(t)
	out := cliCheck(t, h, "type=codex")
	assert.Equal(t, false, out["found"])
	note, _ := out["install_note"].(string)
	assert.Contains(t, note, "untrusted mount point")
	assert.Contains(t, note, `C:\Codex\bin`)
	assert.Contains(t, note, "Settings > Providers")

	agent.UntrustedMountDir = func(string) (string, bool) { return "", false }
	out = cliCheck(t, h, "type=codex")
	note, _ = out["install_note"].(string)
	assert.NotContains(t, note, "untrusted mount point")
}

func TestCLICheckDropsTheInstallCommandForAnUntrustedMount(t *testing.T) {
	prevLook, prevCommon, prevMount := cliLookPath, cliCommonPath, agent.UntrustedMountDir
	t.Cleanup(func() { cliLookPath, cliCommonPath, agent.UntrustedMountDir = prevLook, prevCommon, prevMount })
	cliLookPath = func(string) (string, error) { return "", assert.AnError }
	cliCommonPath = func(string) string { return "" }
	agent.UntrustedMountDir = func(string) (string, bool) { return `C:\Codex\bin`, true }
	out := cliCheck(t, newSystemHandlerForTest(t), "type=codex")
	assert.NotContains(t, out, "install_command", "npm would not fix a folder Windows will not open")
	agent.UntrustedMountDir = func(string) (string, bool) { return "", false }
	out = cliCheck(t, newSystemHandlerForTest(t), "type=codex")
	assert.Contains(t, out, "install_command")
}

// #582: a CLI on PATH only through junctions Windows will not open is found when Coral can follow them to the program, and the check probes that program.
func TestCLICheckFindsTheProgramAnUntrustedMountLeadsTo(t *testing.T) {
	prevLook, prevCommon, prevThrough, prevTemp := cliLookPath, cliCommonPath, cliThroughUntrustedMount, cliTempDirs
	t.Cleanup(func() {
		cliLookPath, cliCommonPath, cliThroughUntrustedMount, cliTempDirs = prevLook, prevCommon, prevThrough, prevTemp
	})
	cliTempDirs = func() []string { return nil } // the test's files are in a temp folder (/tmp on Linux); this is about the junctions
	real := filepath.Join(t.TempDir(), "releases", "0.172.0", "bin", "codex.exe")
	require.NoError(t, os.MkdirAll(filepath.Dir(real), 0o755))
	require.NoError(t, os.WriteFile(real, []byte("not a program"), 0o755))
	tmp := t.TempDir() // the real file is not in the temp folder a launch refuses (os.TempDir: TMP or TEMP on Windows, TMPDIR elsewhere)
	t.Setenv("TMP", tmp)
	t.Setenv("TEMP", tmp)
	t.Setenv("TMPDIR", tmp)
	cliLookPath = func(string) (string, error) { return "", assert.AnError }
	cliCommonPath = func(string) string { return "" }
	cliThroughUntrustedMount = func(string) (string, string, bool) { return real, `C:\Codex\bin`, true }
	out := cliCheck(t, newSystemHandlerForTest(t), "type=codex")
	assert.Equal(t, true, out["found"], "found through the junctions: %v", out)

	cliThroughUntrustedMount = func(string) (string, string, bool) { return "", `C:\Codex\bin`, true }
	out = cliCheck(t, newSystemHandlerForTest(t), "type=codex")
	assert.Equal(t, false, out["found"], "junctions that lead nowhere: not found")
}

// #582 (coral-go-team Security): a configured path through junctions is screened at its real program, as a launch screens it; a path Windows opens as it is is checked as before.
func TestCLICheckScreensWhereAConfiguredPathsJunctionsLead(t *testing.T) {
	prevReal, prevTemp := cliRealPath, cliTempDirs
	t.Cleanup(func() { cliRealPath, cliTempDirs = prevReal, prevTemp })
	tmp := t.TempDir()
	cliTempDirs = func() []string { return []string{tmp} }
	h := newSystemHandlerForTest(t)
	configured := filepath.Join(t.TempDir(), "Codex", "bin", "codex.exe") // never run: the screen refuses it first
	require.NoError(t, store.NewSessionStore(h.db).SetSetting(context.Background(), agent.CLIPathSettingKey("codex"), configured))

	real := filepath.Join(tmp, "releases", "1.0.0", "bin", "codex.exe")
	cliRealPath = func(string) (string, error) { return real, nil }
	out := cliCheck(t, h, "type=codex")
	assert.Equal(t, false, out["found"])
	assert.Equal(t, true, out["configured"])
	msg, _ := out["message"].(string)
	assert.Contains(t, msg, "leads through junctions to "+real)
	assert.Contains(t, msg, "in a temporary folder")

	cliRealPath = func(p string) (string, error) { // junctions Coral would not follow: refused, never checked as typed
		return p, &agent.UnfollowedChainError{Path: p, Err: errors.New("it leads outside your user folders or Program Files")}
	}
	out = cliCheck(t, h, "type=codex")
	assert.Equal(t, false, out["found"])
	assert.Equal(t, true, out["configured"])

	cliRealPath = func(p string) (string, error) { return p, nil } // Windows opens it: no screen, the usual check (here: no file)
	out = cliCheck(t, h, "type=codex")
	assert.Equal(t, false, out["found"])
	msg, _ = out["message"].(string)
	assert.NotContains(t, msg, "junctions")
	assert.Contains(t, msg, "can't be run")
}
