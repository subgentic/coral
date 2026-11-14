package routes

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	terms "github.com/subgentic/coral/pkg/license"
)

// #15997 (the Operator's upgrade to v2.0.67): a computer whose Coral is not running (the Operator had stopped it by hand) is upgraded all the same: install, then start the new release, and no running server is
// needed for any of it. The page reads "unreachable" for it before and "online" on the new release after.
func TestManageUpgradeOfAComputerWhoseCoralIsStoppedInstallsAndStartsTheNewRelease(t *testing.T) {
	me := newManageEnv(t)
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
		return RemoteHealth{Status: store.RemoteStatusUnreachable} // nothing answers: Coral is stopped
	}
	code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	done := me.waitPhase(t, plan, "done")
	assert.Equal(t, 1, me.installs, "the release was installed")
	b, _ := os.ReadFile(me.tmuxLog)
	assert.Equal(t, 1, strings.Count(string(b), "new-session"), "and started")
	steps := done["steps"].([]any)
	assert.Equal(t, "ok", steps[4].(map[string]any)["state"])
	assert.Equal(t, "ok", steps[5].(map[string]any)["state"])
}
