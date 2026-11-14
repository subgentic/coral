package routes

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #15998 (the Operator's ask): a computer set up over SSH whose Coral is not running has a Start Coral. It starts the newest release installed under ~/.coral-server with the data folder, the backend and the port
// that computer was set up with, waits for the Coral to answer, and touches nothing else: no download, no install, no stop, nothing outside the install folder.

// stoppedUntilStarted answers the health check as a stopped Coral does until the daemon start has run (its note in the log), and as the started Coral after.
func (me *manageEnv) stoppedUntilStarted() {
	me.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		for i := 0; i < 60; i++ {
			if b, _ := os.ReadFile(me.tmuxLog); strings.Contains(string(b), "new-session") {
				return RemoteHealth{Status: store.RemoteStatusOnline, Version: "2.0.10"}
			}
			time.Sleep(50 * time.Millisecond)
		}
		return RemoteHealth{Status: store.RemoteStatusUnreachable}
	}
}

func (me *manageEnv) startLine(t *testing.T) string {
	b, _ := os.ReadFile(filepath.Join(me.dir, "startline"))
	return string(b)
}

func (me *manageEnv) runStart(t *testing.T) map[string]any {
	_, v := me.plan(t, "start", nil)
	plan, _ := v["plan"].(string)
	require.NotEmpty(t, plan, "%v", v)
	me.connectAndRun(t, plan, map[string]any{}, 202) // no terms: nothing is installed or recorded
	return me.waitPhase(t, plan, "done")
}

// failText is what the failed steps of a plan say.
func failText(v map[string]any) string {
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

func stepStates(done map[string]any) map[string]string {
	out := map[string]string{}
	for _, s := range done["steps"].([]any) {
		m := s.(map[string]any)
		out[m["name"].(string)] = m["state"].(string)
	}
	return out
}

func TestStartCoralStartsTheNewestInstalledReleaseWithItsKeptDataAndTouchesNothingElse(t *testing.T) {
	me := newManageEnv(t)
	me.stoppedUntilStarted()
	// a folder with no runnable Coral in it (an install that was cut short) is not a release to start, however new its number
	require.NoError(t, os.MkdirAll(filepath.Join(me.home, ".coral-server", "2.0.11", "root"), 0o755))
	// the data folder and the backend recorded at the last start
	require.NoError(t, os.MkdirAll(filepath.Join(me.home, "coraldata"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "datadir"), []byte("coraldata"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "backend"), []byte("tmux"), 0o600))

	done := me.runStart(t)
	st := stepStates(done)
	assert.Equal(t, "ok", st["start"], "%v", done)
	assert.Equal(t, "ok", st["verify"], "%v", done)
	line := me.startLine(t)
	root := filepath.Join(me.home, ".coral-server")
	assert.Contains(t, line, "2.0.10/root/coral", "the newest release that can run")
	assert.NotContains(t, line, "2.0.11", "a folder with no Coral in it is not started")
	assert.Contains(t, line, "--port 8420", "the port it was set up on")
	assert.Contains(t, line, "--backend", "the backend is the recorded one")
	b, _ := os.ReadFile(me.tmuxLog)
	assert.NotContains(t, string(b), "kill-session", "a start stops nothing")
	assert.Equal(t, 0, me.installs, "a start installs nothing")
	got, _ := os.ReadFile(filepath.Join(root, "datadir"))
	assert.Equal(t, "coraldata", string(got), "the data folder kept")
	// the start text names files under the install folder and the data folder that was recorded, and no other path of the computer
	for _, p := range regexp.MustCompile(`/[A-Za-z0-9_./-]+`).FindAllString(line, -1) {
		if strings.HasPrefix(p, me.home) {
			assert.True(t, strings.HasPrefix(p, root) || strings.HasPrefix(p, filepath.Join(me.home, "coraldata")) || p == me.home, "outside the install folder: %s", p)
		}
	}
}

func TestStartCoralLeavesARunningCoralAlone(t *testing.T) {
	me := newManageEnv(t)
	me.version = "2.0.10" // it answers
	done := me.runStart(t)
	st := stepStates(done)
	assert.Equal(t, "skipped", st["start"], "%v", done)
	assert.Empty(t, me.startLine(t), "a Coral that answers was started a second time")
}

func TestStartCoralWithNothingInstalledSaysSoAndStartsNothing(t *testing.T) {
	me := newManageEnv(t)
	me.stoppedUntilStarted()
	require.NoError(t, os.RemoveAll(filepath.Join(me.home, ".coral-server", "2.0.10")))
	_, v := me.plan(t, "start", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	failed := me.waitPhase(t, plan, "failed")
	assert.Contains(t, failText(failed), "No release of Coral is installed", "%v", failed)
	assert.Empty(t, me.startLine(t))
}

func TestStartCoralRefusesWhenAnotherProgramHoldsThePortAndStartsNothing(t *testing.T) {
	me := newManageEnv(t)
	me.stoppedUntilStarted()
	require.NoError(t, os.WriteFile(filepath.Join(me.dir, "portheld"), nil, 0o600))
	_, v := me.plan(t, "start", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	failed := me.waitPhase(t, plan, "failed")
	assert.Contains(t, failText(failed), "8420", "%v", failed)
	assert.Empty(t, me.startLine(t), "a start went ahead on a held port")
}

func TestStartCoralNeverActsOnAnotherComputerAndTheDaemonStartCommandIsTheFixedOne(t *testing.T) {
	me := newManageEnv(t)
	me.stoppedUntilStarted()
	require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "instance-id"), []byte(strings.Repeat("f", 32)+"\n"), 0o600))
	_, v := me.plan(t, "start", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	me.waitPhase(t, plan, "failed")
	assert.Empty(t, me.startLine(t), "a start was sent to a computer that is not the one set up")
	// a request cannot name what to start: the plan is the server's id and the action, nothing else
	code, _ := me.do("POST", "/api/servers/provision/plan", map[string]any{"server_id": "ssh-box", "action": "start", "target": "evil@elsewhere.example.com"})
	assert.Equal(t, 400, code)
}
