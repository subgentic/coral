package routes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	terms "github.com/subgentic/coral/pkg/license"
)

// #16021 (the Operator's Coral keeps its data outside .coral-server/data): an upgrade keeps the folder the running Coral actually uses, read from its --home before anything is stopped. Never a silent start in
// the default folder.

// upgradeWithRunningHome runs an upgrade of a Coral whose command line says runs (what CmdReadRunningHome prints; "" for none) and returns the phase it ended in and the finished plan.
func (me *manageEnv) upgradeWithRunningHome(t *testing.T, runs string) (string, map[string]any) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(me.dir, "runninghome"), []byte(runs), 0o600))
	want := config.ReportedVersion()
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	_, st := me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, "connected", st["phase"])
	me.p.eula = func() (bool, bool) { return true, true }
	me.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		me.mu.Lock()
		defer me.mu.Unlock()
		if me.sawStart() {
			return RemoteHealth{Status: store.RemoteStatusOnline, Version: want}
		}
		return RemoteHealth{Status: store.RemoteStatusUnreachable}
	}
	code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, v := me.do("GET", "/api/servers/provision/"+plan, nil)
		if ph, _ := v["phase"].(string); ph == "done" || ph == "failed" || time.Now().After(deadline) {
			return ph, v
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (me *manageEnv) datadirFile() string {
	b, _ := os.ReadFile(filepath.Join(me.home, ".coral-server", "datadir"))
	return string(b)
}

func TestUpgradeKeepsTheDataFolderUnderTheHomeFolderThatTheRunningCoralUses(t *testing.T) {
	me := newManageEnv(t)
	phase, done := me.upgradeWithRunningHome(t, "rel mydata")
	require.Equal(t, "done", phase, "%v", done)
	assert.Equal(t, "mydata", me.datadirFile(), "the start after the upgrade keeps the folder the Coral ran from")
	_, err := os.Stat(filepath.Join(me.home, "mydata"))
	assert.NoError(t, err)
	assert.Equal(t, 1, me.installs)
	assert.Contains(t, dataHomeStepDetail(done, "restart"), "Keeping its data folder ~/mydata.")
}

func TestUpgradeKeepsAnAbsoluteDataFolderOnlyWhenItIsACoralDataFolderAndSaysSo(t *testing.T) {
	me := newManageEnv(t)
	outside, err := os.MkdirTemp("", "dh") // a short path: a folder name of a data folder is at most 61 characters
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(outside) })
	require.NoError(t, os.WriteFile(filepath.Join(outside, "sessions.db"), nil, 0o600))
	phase, done := me.upgradeWithRunningHome(t, "abs "+outside)
	require.Equal(t, "done", phase, "%v", done)
	assert.Equal(t, outside, me.datadirFile())
	assert.Contains(t, dataHomeStepDetail(done, "restart"), "Keeping its data folder "+outside+".")
}

func TestUpgradeOfACoralWhoseDataFolderIsNotOneItCanKeepChangesNothingAndSaysWhy(t *testing.T) {
	for name, runs := range map[string]string{"abs": "", "relative": "relative data", "denied": "rel .ssh"} {
		t.Run(name, func(t *testing.T) {
			me := newManageEnv(t)
			if name == "abs" { // a folder with no sessions.db in it
				empty := filepath.Join(me.dir, "empty")
				require.NoError(t, os.MkdirAll(empty, 0o700))
				runs = "abs " + empty
			}
			phase, failed := me.upgradeWithRunningHome(t, runs)
			require.Equal(t, "failed", phase, "%v", failed)
			assert.Equal(t, 0, me.installs, "nothing was installed")
			b, _ := os.ReadFile(me.tmuxLog)
			assert.NotContains(t, string(b), "kill-session", "nothing was stopped")
			assert.Empty(t, me.datadirFile(), "nothing was recorded")
			assert.Contains(t, dataHomeFailText(failed), "Nothing was changed.")
		})
	}
}

func TestUpgradeOfACoralStartedWithNoDataFolderOptionKeepsWhatWasRecorded(t *testing.T) {
	me := newManageEnv(t)
	require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "datadir"), []byte(".coral"), 0o600))
	phase, done := me.upgradeWithRunningHome(t, "")
	require.Equal(t, "done", phase, "%v", done)
	assert.Equal(t, ".coral", me.datadirFile())
	assert.NotContains(t, dataHomeStepDetail(done, "restart"), "Keeping")
}

func dataHomeStepDetail(v map[string]any, name string) string {
	for _, s := range v["steps"].([]any) {
		if m := s.(map[string]any); m["name"] == name {
			d, _ := m["detail"].(string)
			return d
		}
	}
	return ""
}

// failText is what the failed steps of a plan say.
func dataHomeFailText(v map[string]any) string {
	var out []string
	for _, s := range v["steps"].([]any) {
		m := s.(map[string]any)
		if m["state"] == "failed" {
			d, _ := m["detail"].(string)
			out = append(out, d)
		}
	}
	return strings.Join(out, " ")
}

// #16047 (Security's INFO on #16021): the refusal sentence names the far --home, which is another computer's text: cut to a sane length, and only printable characters.
func TestUpgradeRefusalSentenceCutsAndCleansTheRemoteDataFolderText(t *testing.T) {
	for name, runs := range map[string]string{
		"long rel":   "rel .ssh/" + strings.Repeat("a", 300),
		"long abs":   "abs /" + strings.Repeat("b", 300),
		"escape abs": "abs /srv/x\x1b[31mred",
	} {
		t.Run(name, func(t *testing.T) {
			me := newManageEnv(t)
			phase, failed := me.upgradeWithRunningHome(t, runs)
			require.Equal(t, "failed", phase, "%v", failed)
			text := dataHomeFailText(failed)
			assert.NotContains(t, text, "\x1b", "a control character reached the sentence")
			assert.Less(t, len(text), 400, "the remote text was not cut: %d characters", len(text))
			assert.Contains(t, text, "Nothing was changed.")
		})
	}
}
