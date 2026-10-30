package routes

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
	terms "github.com/subgentic/coral/pkg/license"
)

type manageEnv struct {
	*provEnv
	home     string
	tmuxLog  string
	removed  []string
	mu       sync.Mutex
	version  string // what the new server's health says
	installs int
}

// newManageEnv is a registered ssh server and a far computer that runs the real sh in a temp HOME, with a fake tmux that logs.
func newManageEnv(t *testing.T) *manageEnv {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ssh is a shell script")
	}
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	home := filepath.Join(pe.dir, "far")
	bin := filepath.Join(pe.dir, "farbin")
	tmuxLog := filepath.Join(pe.dir, "tmux.log")
	for _, d := range []string{filepath.Join(home, ".coral-server", "2.0.9", "root"), filepath.Join(home, ".coral-server", "data"), bin} {
		require.NoError(t, os.MkdirAll(d, 0o755))
	}
	require.NoError(t, os.WriteFile(filepath.Join(home, ".coral-server", "instance-id"), []byte(provInstance+"\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(home, ".coral-server", "data", "api_key"), []byte(provKey+"\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(bin, "tmux"), []byte("#!/bin/sh\necho \"$@\" >> '"+tmuxLog+"'\n[ \"$1\" = has-session ] && exit 1\nexit 0\n"), 0o755))
	// the check after a stop reads /proc/net/tcp, which a Mac has not: it is answered here (a file named stuck means Coral will not stop)
	script := "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\ncase \"$last\" in *\"uname -sm\"*) echo 'Linux x86_64'; exit 0;; *\"command -v tmux\"*) exit 0;; *\"/proc/net/tcp\"*) [ -e '" + filepath.Join(pe.dir, "stuck") + "' ] && exit 1; exit 0;; esac\nHOME='" + home + "'; export HOME\nPATH='" + bin + ":'\"$PATH\"; export PATH\neval \"$last\"\n"
	require.NoError(t, os.WriteFile(filepath.Join(pe.dir, "ssh"), []byte(script), 0o700))
	pe.p.runner = sshprov.Runner{SSH: filepath.Join(pe.dir, "ssh")}
	pe.p.version = "2.0.10"
	farCoral := filepath.Join(home, ".coral-server", "2.0.10", "root")
	require.NoError(t, os.MkdirAll(farCoral, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(farCoral, "coral"), []byte("#!/bin/sh\ncat >/dev/null\nexit 0\n"), 0o755)) // accept-terms reads its stdin

	me := &manageEnv{provEnv: pe, home: home, tmuxLog: tmuxLog, version: "0.0.1"}
	_, err := pe.e.h.store.AddSSH(context.Background(), "ssh-box", "Build box", "rich@box.example.com:22", 8420, provInstance, provKey)
	require.NoError(t, err)
	pe.p.install = func(_ context.Context, p *provisionPlan, _ sshprov.Arch) error {
		me.mu.Lock()
		me.installs++
		me.mu.Unlock()
		p.setStep("install", stepOK, "Installed.")
		return nil
	}
	pe.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		me.mu.Lock()
		defer me.mu.Unlock()
		return RemoteHealth{Status: store.RemoteStatusOnline, Version: me.version}
	}
	pe.p.SetOnRemoved(func(id string) { me.mu.Lock(); me.removed = append(me.removed, id); me.mu.Unlock() })
	return me
}

func (me *manageEnv) plan(t *testing.T, action string, extra map[string]any) (int, map[string]any) {
	body := map[string]any{"server_id": "ssh-box", "action": action}
	for k, v := range extra {
		body[k] = v
	}
	return me.do("POST", "/api/servers/provision/plan", body)
}

func (me *manageEnv) connectAndRun(t *testing.T, plan string, run map[string]any, wantRun int) map[string]any {
	_, v := me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, "connected", v["phase"], "%v", v)
	code, v := me.do("POST", "/api/servers/provision/"+plan+"/run", run)
	require.Equal(t, wantRun, code, "%v", v)
	return v
}

func TestManagePlanValidation(t *testing.T) {
	me := newManageEnv(t)
	_, err := me.e.h.store.Add(context.Background(), "web", "By URL", "http://10.0.0.5:8420", routeSecret, true)
	require.NoError(t, err)
	for name, c := range map[string]struct {
		body map[string]any
		code int
	}{
		"unknown server":    {map[string]any{"server_id": "nope", "action": "stop"}, 404},
		"a url server":      {map[string]any{"server_id": "web", "action": "stop"}, 400},
		"no action":         {map[string]any{"server_id": "ssh-box"}, 400},
		"another action":    {map[string]any{"server_id": "ssh-box", "action": "format"}, 400},
		"a target too":      {map[string]any{"server_id": "ssh-box", "action": "stop", "target": "evil@elsewhere.example.com"}, 400},
		"an alias too":      {map[string]any{"server_id": "ssh-box", "action": "stop", "alias": "x"}, 400},
		"delete with stop":  {map[string]any{"server_id": "ssh-box", "action": "stop", "delete_data": true}, 400},
		"action alone":      {map[string]any{"action": "remove"}, 400},
		"delete_data alone": {map[string]any{"delete_data": true, "target": "rich@box.example.com"}, 400},
	} {
		code, v := me.do("POST", "/api/servers/provision/plan", c.body)
		assert.Equal(t, c.code, code, "%s: %v", name, v)
	}
	code, v := me.plan(t, "stop", nil)
	require.Equal(t, 201, code, "%v", v)
	assert.Equal(t, "stop", v["kind"])
	assert.Equal(t, "rich@box.example.com:22", v["target"], "the target is the registry's")
	code, _ = me.plan(t, "remove", nil)
	assert.Equal(t, 409, code, "two things at once for one server")
}

func TestManageStopKeepsEverythingButTheRunningCoral(t *testing.T) {
	me := newManageEnv(t)
	_, v := me.plan(t, "stop", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202) // no terms for a stop
	done := me.waitPhase(t, plan, "done")
	assert.Equal(t, "ok", done["steps"].([]any)[2].(map[string]any)["state"])
	b, _ := os.ReadFile(me.tmuxLog)
	assert.Contains(t, string(b), "kill-session -t =coral-server")
	assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "2.0.9")))
	assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "data", "api_key")))
	_, err := me.e.h.store.Get(context.Background(), "ssh-box")
	assert.NoError(t, err, "a stop removed the server from the list")
}

func TestManageRemoveNeedsTheNameTypedAndKeepsTheDataUnlessAsked(t *testing.T) {
	me := newManageEnv(t)
	_, v := me.plan(t, "remove", nil)
	plan := v["plan"].(string)
	assert.Equal(t, false, v["delete_data"])
	_, st := me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, "connected", st["phase"])
	for _, body := range []map[string]any{{}, {"confirm": "ssh-other"}, {"confirm": "SSH-BOX"}} {
		code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", body)
		assert.Equal(t, 400, code, "%v", body)
	}
	_, still := me.do("GET", "/api/servers/provision/"+plan, nil)
	assert.Equal(t, "connected", still["phase"], "a refused remove changed the plan")
	assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "2.0.9")))

	code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"confirm": "ssh-box"})
	require.Equal(t, 202, code)
	me.waitPhase(t, plan, "done")
	assert.False(t, farHas(filepath.Join(me.home, ".coral-server", "2.0.9")), "the release was not deleted")
	assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "data", "api_key")), "the data was deleted without being asked")
	assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "instance-id")))
	_, err := me.e.h.store.Get(context.Background(), "ssh-box")
	assert.ErrorIs(t, err, store.ErrRemoteNotFound)
	me.mu.Lock()
	assert.Equal(t, []string{"ssh-box"}, me.removed, "the resolver was not told")
	me.mu.Unlock()
}

func TestManageRemoveWithDataDeletesTheWholeInstallFolder(t *testing.T) {
	me := newManageEnv(t)
	_, v := me.plan(t, "remove", map[string]any{"delete_data": true})
	plan := v["plan"].(string)
	assert.Equal(t, true, v["delete_data"], "the plan the person confirms says the data goes too")
	me.connectAndRun(t, plan, map[string]any{"confirm": "ssh-box"}, 202)
	me.waitPhase(t, plan, "done")
	assert.False(t, farHas(filepath.Join(me.home, ".coral-server")))
	assert.True(t, farHas(me.home), "more than the install folder was deleted")
}

func TestManageNeverActsOnAComputerThatIsNotTheOneSetUp(t *testing.T) {
	for _, action := range []string{"stop", "remove", "upgrade"} {
		me := newManageEnv(t)
		require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "instance-id"), []byte(strings.Repeat("f", 32)+"\n"), 0o600))
		_, v := me.plan(t, action, nil)
		plan := v["plan"].(string)
		_, st := me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
		require.Equal(t, "connected", st["phase"])
		code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"confirm": "ssh-box", "accept_terms": true, "terms_sha256": terms.EULADigest()})
		require.Equal(t, 202, code, action)
		failed := me.waitPhase(t, plan, "failed")
		assert.Equal(t, "That is not the computer that was set up, so nothing was changed.", failed["error"], action)
		assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "2.0.9")), action)
		b, _ := os.ReadFile(me.tmuxLog)
		assert.NotContains(t, string(b), "kill-session", action)
		_, err := me.e.h.store.Get(context.Background(), "ssh-box")
		assert.NoError(t, err, action)
		assert.Equal(t, 0, me.installs, action)
	}
}

func TestManageUpgradeInstallsRestartsAndChecksTheNewVersion(t *testing.T) {
	me := newManageEnv(t)
	want := config.ReportedVersion()
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	_, st := me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, "connected", st["phase"])
	// an upgrade records the terms, so it wants the press and the digest like a setup
	code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{})
	assert.Equal(t, 400, code)
	code, _ = me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": strings.Repeat("0", 64)})
	assert.Equal(t, 409, code)

	// after the restart the new release answers
	me.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		me.mu.Lock()
		defer me.mu.Unlock()
		if b, _ := os.ReadFile(me.tmuxLog); strings.Contains(string(b), "new-session") {
			return RemoteHealth{Status: store.RemoteStatusOnline, Version: want}
		}
		return RemoteHealth{Status: store.RemoteStatusOnline, Version: "0.0.1"}
	}
	code, _ = me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	done := me.waitPhase(t, plan, "done")
	assert.Equal(t, 1, me.installs)
	b, _ := os.ReadFile(me.tmuxLog)
	assert.Equal(t, 1, strings.Count(string(b), "kill-session"))
	assert.Equal(t, 1, strings.Count(string(b), "new-session"))
	assert.Less(t, strings.Index(string(b), "kill-session"), strings.Index(string(b), "new-session"), "started before it was stopped")
	steps := done["steps"].([]any)
	assert.Equal(t, "ok", steps[4].(map[string]any)["state"])
	assert.Equal(t, "ok", steps[5].(map[string]any)["state"])
	assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "data", "api_key")), "the data was touched")
}

func TestManageUpgradeLeavesARunningCurrentReleaseAlone(t *testing.T) {
	me := newManageEnv(t)
	me.version = config.ReportedVersion()
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()}, 202)
	done := me.waitPhase(t, plan, "done")
	assert.Equal(t, 0, me.installs, "downloaded and installed a release that is already running")
	b, _ := os.ReadFile(me.tmuxLog)
	assert.Empty(t, string(b), "a session that runs the current release was touched")
	assert.Equal(t, "skipped", done["steps"].([]any)[3].(map[string]any)["state"])
}

func TestManageUpgradeFailsWhenTheNewReleaseDoesNotAnswer(t *testing.T) {
	me := newManageEnv(t) // health keeps saying the old version
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()}, 202)
	failed := me.waitPhase(t, plan, "failed")
	assert.Equal(t, "The new release was started, but it did not answer as expected.", failed["error"])
}

func farHas(p string) bool { _, err := os.Stat(p); return err == nil }

// A stop that cannot be confirmed leaves everything where it is: remove deletes nothing and keeps the row, upgrade does not restart.
func TestManageNothingIsDeletedOrRestartedWhenTheStopIsNotConfirmed(t *testing.T) {
	defer sshprov.SetStopTimingForTest(200*time.Millisecond, 20*time.Millisecond)()
	for _, action := range []string{"remove", "upgrade"} {
		me := newManageEnv(t)
		require.NoError(t, os.WriteFile(filepath.Join(me.dir, "stuck"), nil, 0o600))
		_, v := me.plan(t, action, map[string]any{"delete_data": action == "remove"})
		plan := v["plan"].(string)
		me.connectAndRun(t, plan, map[string]any{"confirm": "ssh-box", "accept_terms": true, "terms_sha256": terms.EULADigest()}, 202)
		failed := me.waitPhase(t, plan, "failed")
		assert.Contains(t, failed["error"], "did not stop", action)
		assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "2.0.9")), action+": a release was deleted")
		assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "data", "api_key")), action+": the data was deleted")
		assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "instance-id")), action)
		_, err := me.e.h.store.Get(context.Background(), "ssh-box")
		assert.NoError(t, err, action+": the row was dropped")
		b, _ := os.ReadFile(me.tmuxLog)
		assert.NotContains(t, string(b), "new-session", action+": a new session was started")
		me.mu.Lock()
		assert.Empty(t, me.removed, action)
		me.mu.Unlock()
	}
}
