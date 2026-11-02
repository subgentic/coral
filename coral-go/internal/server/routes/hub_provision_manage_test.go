package routes

import (
	"context"
	"fmt"
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
	// the daemon start (#12217) goes through nohup: it is answered here by a note in the same log, "new-session", and starts nothing (the stand-in for a start the test asks about)
	require.NoError(t, os.WriteFile(filepath.Join(bin, "nohup"), []byte("#!/bin/sh\necho \"new-session daemon\" >> '"+tmuxLog+"'\nexit 0\n"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(bin, "tmux"), []byte("#!/bin/sh\necho \"$@\" >> '"+tmuxLog+"'\n[ \"$1\" = has-session ] && exit 1\nexit 0\n"), 0o755))
	// the checks read ps and /proc/net/tcp, which a Mac has not or answers otherwise: they are answered here (a file named stuck means Coral will not stop; nothing holds 8420)
	script := "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\ncase \"$last\" in *\"uname -sm\"*) echo 'Linux x86_64'; exit 0;; \"command -v tmux >/dev/null 2>&1\") exit 0;; *\"ps -u\"*) [ -e '" + filepath.Join(pe.dir, "stuck") + "' ] && exit 1; exit 0;; *\"/proc/net/tcp\"*) [ -e '" + filepath.Join(pe.dir, "portheld") + "' ] && exit 2; exit 0;; esac\nHOME='" + home + "'; export HOME\nPATH='" + bin + ":'\"$PATH\"; export PATH\neval \"$last\"\n"
	require.NoError(t, os.WriteFile(filepath.Join(pe.dir, "ssh"), []byte(script), 0o700))
	pe.p.runner = sshprov.Runner{SSH: filepath.Join(pe.dir, "ssh")}
	pe.p.version = "2.0.10"
	farCoral := filepath.Join(home, ".coral-server", "2.0.10", "root")
	require.NoError(t, os.MkdirAll(farCoral, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(farCoral, "coral"), []byte("#!/bin/sh\ncat >/dev/null\nexit 0\n"), 0o755)) // accept-terms reads its stdin

	me := &manageEnv{provEnv: pe, home: home, tmuxLog: tmuxLog, version: "0.0.0-a"}
	_, err := pe.e.h.store.AddSSH(context.Background(), "ssh-box", "Build box", "user@box.example.com:22", 8420, provInstance, provKey)
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

// sawStart is whether the daemon start has been seen in the log: the start is a background process (#12217), so its note in the log may land a moment after the command returned.
func (me *manageEnv) sawStart() bool {
	if b, _ := os.ReadFile(me.tmuxLog); !strings.Contains(string(b), "kill-session") {
		return false // nothing was stopped yet, so no start is coming: no waiting
	}
	for i := 0; i < 60; i++ {
		if b, _ := os.ReadFile(me.tmuxLog); strings.Contains(string(b), "new-session") {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
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
		"delete_data alone": {map[string]any{"delete_data": true, "target": "user@box.example.com"}, 400},
	} {
		code, v := me.do("POST", "/api/servers/provision/plan", c.body)
		assert.Equal(t, c.code, code, "%s: %v", name, v)
	}
	code, v := me.plan(t, "stop", nil)
	require.Equal(t, 201, code, "%v", v)
	assert.Equal(t, "stop", v["kind"])
	assert.Equal(t, "user@box.example.com:22", v["target"], "the target is the registry's")
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
	// an upgrade records the hub's acceptance like a setup, so with no marker for the current terms it does nothing
	me.p.eula = func() (bool, bool) { return true, false }
	code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	assert.Equal(t, 409, code)
	me.p.eula = func() (bool, bool) { return true, true }

	// after the restart the new release answers
	me.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		me.mu.Lock()
		defer me.mu.Unlock()
		if me.sawStart() {
			return RemoteHealth{Status: store.RemoteStatusOnline, Version: want}
		}
		return RemoteHealth{Status: store.RemoteStatusOnline, Version: "0.0.0-a"}
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

// An upgrade gives a computer set up before the owner stamp existed its secret, once, and never rotates one it holds (#11378).
func TestManageUpgradeGivesAnOlderComputerItsOwnerSecretOnceAndNeverRotatesIt(t *testing.T) {
	me := newManageEnv(t)
	want := config.ReportedVersion()
	me.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		if me.sawStart() {
			return RemoteHealth{Status: store.RemoteStatusOnline, Version: want}
		}
		return RemoteHealth{Status: store.RemoteStatusOnline, Version: "0.0.0-a"}
	}
	run := func() {
		_, v := me.plan(t, "upgrade", nil)
		plan := v["plan"].(string)
		me.connectAndRun(t, plan, map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()}, 202)
		me.waitPhase(t, plan, "done")
		me.do("DELETE", "/api/servers/provision/"+plan, nil) // a finished plan holds its server until it is dropped or expires
	}
	run()
	require.Len(t, me.ownerGiven, 1)
	first, ok, err := me.e.h.store.OwnerSecret(context.Background(), "ssh-box")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, me.ownerGiven[0], first)
	// a second upgrade (the tmux log now has a session, health says the new version at once) installs nothing and keeps the secret
	_ = os.Remove(me.tmuxLog)
	run()
	assert.Len(t, me.ownerGiven, 1, "an upgrade rotated a secret the hub already held")
	again, _, _ := me.e.h.store.OwnerSecret(context.Background(), "ssh-box")
	assert.Equal(t, first, again)
}

// An upgrade whose restart finds 8420 held by another user's Coral fails with the sentence that names the port (QA Engineer's gap on #11429): this user's Coral was stopped, so nothing is deleted, and no
// new session is started.
func TestManageUpgradeNamesPort8420WhenAnotherHoldsItAndStartsNothing(t *testing.T) {
	defer sshprov.SetStopTimingForTest(200*time.Millisecond, 20*time.Millisecond)()
	me := newManageEnv(t)
	require.NoError(t, os.WriteFile(filepath.Join(me.dir, "portheld"), nil, 0o600))
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	failed := me.waitPhase(t, plan, "failed")
	assert.Equal(t, portInUseSentence, failed["error"])
	b, _ := os.ReadFile(me.tmuxLog)
	assert.Contains(t, string(b), "kill-session", "this user's Coral was stopped first")
	assert.NotContains(t, string(b), "new-session", "and nothing was started over the other user's Coral")
	assert.True(t, farHas(filepath.Join(me.home, ".coral-server", "data", "api_key")), "the data was not touched")
}

// An upgrade shows the computer's version beside this hub's (#12217) and refuses to put this hub's OLDER release over a newer one unless the person allows it; nothing is stopped or installed by the refusal.
func TestManageUpgradeRefusesADowngradeUnlessAllowed(t *testing.T) {
	// this hub's version is set here, not assumed from the tests that ran before (other tests in the package change config.Version): a hub that reads as 99.0.0 or newer, or as unreadable, would plan no downgrade (v2.0.35's go-tests, 61fb4fec5)
	prev := config.Version
	config.Version = "2.0.35"
	t.Cleanup(func() { config.Version = prev })
	me := newManageEnv(t)
	hub := config.ReportedVersion()
	me.p.eula = func() (bool, bool) { return true, true }
	newer := "99.0.0"
	me.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		me.mu.Lock()
		defer me.mu.Unlock()
		if me.sawStart() {
			return RemoteHealth{Status: store.RemoteStatusOnline, Version: hub}
		}
		return RemoteHealth{Status: store.RemoteStatusOnline, Version: newer}
	}
	code, v := me.plan(t, "upgrade", nil)
	require.Equal(t, 201, code, "%v", v)
	assert.Equal(t, hub, v["hub_version"])
	assert.Equal(t, newer, v["remote_version"], "the computer's version is on the plan, before anything runs")
	assert.Equal(t, true, v["downgrade"])
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	failed := me.waitPhase(t, plan, "failed")
	assert.Contains(t, failed["error"], "newer Coral than this hub (99.0.0")
	assert.Zero(t, me.installs, "nothing was installed")
	if b, _ := os.ReadFile(me.tmuxLog); strings.Contains(string(b), "kill-session") || strings.Contains(string(b), "new-session") {
		t.Errorf("a refused downgrade stopped or started Coral:\n%s", b)
	}

	// allowed by the person, in the run request: it goes ahead
	code, _ = me.do("DELETE", "/api/servers/provision/"+plan, nil)
	require.Equal(t, 200, code)
	code, v = me.plan(t, "upgrade", nil)
	require.Equal(t, 201, code, "%v", v)
	plan = v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{"allow_downgrade": true}, 202)
	me.waitPhase(t, plan, "done")
	assert.Equal(t, 1, me.installs)

	// the flag means nothing on a plan that is not an upgrade, and an unreadable or equal version is not a downgrade
	assert.False(t, remoteIsNewer("", hub))
	assert.False(t, remoteIsNewer(hub, hub))
	assert.False(t, remoteIsNewer("not a version", hub))
	assert.True(t, remoteIsNewer("99.0.0", "2.0.33"))
	assert.Equal(t, "", cleanVersionText("2.0.33 <script>"))
	assert.Equal(t, "2.0.33", cleanVersionText("2.0.33"))
}

// Before the person presses Upgrade the page is told whether that computer's agents survive the restart (#12233): the backend recorded there, or tmux where it is installed and nothing was recorded (a
// server set up before the choice existed).
func TestManageUpgradePlanSaysWhetherTheAgentsSurviveTheRestart(t *testing.T) {
	for name, c := range map[string]struct {
		recorded string
		want     bool
	}{"pty recorded": {"pty", false}, "tmux recorded": {"tmux", true}, "nothing recorded, tmux installed": {"", true}} {
		me := newManageEnv(t)
		if c.recorded != "" {
			require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "backend"), []byte(c.recorded), 0o600))
		}
		_, v := me.plan(t, "upgrade", nil)
		plan := v["plan"].(string)
		assert.NotContains(t, v, "agents_survive", name+": not known before it connects")
		_, v = me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
		require.Equal(t, "connected", v["phase"], "%s: %v", name, v)
		assert.Equal(t, c.want, v["agents_survive"], name)
	}
}

// #12263: a plan that is Done holds nothing: the next Upgrade, Stop or Remove for that server starts at once, with no hub restart and no Close. One that is still going holds the server (409).
func TestAFinishedPlanDoesNotHoldTheServersLock(t *testing.T) {
	me := newManageEnv(t)
	_, v := me.plan(t, "stop", nil)
	first := v["plan"].(string)
	code, _ := me.plan(t, "upgrade", nil)
	assert.Equal(t, 409, code, "a plan that has not run holds the server")
	me.connectAndRun(t, first, map[string]any{}, 202)
	me.waitPhase(t, first, "done")
	code, v = me.plan(t, "upgrade", nil)
	require.Equal(t, 201, code, "a Done plan is not in the way: %v", v)
	assert.Equal(t, "upgrade", v["kind"])
	code, _ = me.plan(t, "stop", nil)
	assert.Equal(t, 409, code, "and the new one holds it in its turn")
}

// #12263 (Security): deleting the data never removes a link or a folder that is not a Coral's: the step fails in its own words, nothing is deleted, and the server stays on the hub's list.
func TestManageRemoveWithDataRefusesAFolderThatIsALinkOrNotOurs(t *testing.T) {
	for name, c := range map[string]struct {
		setup func(me *manageEnv) string
		said  string
	}{
		"a link": {func(me *manageEnv) string {
			install := filepath.Join(me.home, ".coral-server")
			target := filepath.Join(me.home, "elsewhere")
			require.NoError(t, os.Rename(install, target))
			require.NoError(t, os.Symlink(target, install))
			return filepath.Join(target, "data", "api_key")
		}, "nothing was deleted"},
		// with no instance id the identity check stops the plan before anything is stopped or deleted; the guard in the command itself is sshprov's own test
		"a folder with no instance id": {func(me *manageEnv) string {
			require.NoError(t, os.Remove(filepath.Join(me.home, ".coral-server", "instance-id")))
			return filepath.Join(me.home, ".coral-server", "data", "api_key")
		}, "nothing was changed"},
	} {
		t.Run(name, func(t *testing.T) {
			me := newManageEnv(t)
			kept := c.setup(me)
			_, v := me.plan(t, "remove", map[string]any{"delete_data": true})
			plan := v["plan"].(string)
			me.connectAndRun(t, plan, map[string]any{"confirm": "ssh-box"}, 202)
			failed := me.waitPhase(t, plan, "failed")
			assert.Contains(t, fmt.Sprint(failed["steps"]), c.said, "its own words, not the CLI's")
			assert.True(t, farHas(kept), "the data is still there")
			_, err := me.e.h.store.Get(context.Background(), "ssh-box")
			assert.NoError(t, err, "and the server is still on the list")
		})
	}
}
