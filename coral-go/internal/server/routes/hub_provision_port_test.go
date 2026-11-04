package routes

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/sshprov"
	terms "github.com/subgentic/coral/pkg/license"
)

// The port the far Coral listens on is the person's choice (#13081): a set up on 8461 starts Coral with --port 8461, checks that port, registers the computer with it and says it in the plan; an upgrade starts the new
// release on the port stored with the computer; a refused port never reaches the far side.

func sshLogOf(t *testing.T, pe *provEnv) string {
	t.Helper()
	b, _ := os.ReadFile(pe.sshLog)
	return string(b)
}

func TestProvisionPortChoiceEndToEnd(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	gotPort := 0
	pe.p.startRemote = func(_ context.Context, p *provisionPlan) (string, string, error) {
		gotPort = p.portOrDefault()
		return provInstance, provKey, nil
	}
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "user@box.example.com"})
	plan := v["plan"].(string)
	assert.EqualValues(t, 8420, v["port"], "the default")
	pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	for _, bad := range []int{80, 1023, 65536, 70000, -1} {
		code, v := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"port": bad})
		assert.Equal(t, 400, code, bad)
		assert.NotEmpty(t, v["error"], "it says why")
	}
	code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest(), "port": 8461})
	require.Equal(t, 202, code)
	got := pe.waitPhase(t, plan, "done")
	assert.EqualValues(t, 8461, got["port"], "the plan says which port")
	assert.Equal(t, 8461, gotPort, "the start is given the chosen port")
	row, err := pe.e.h.store.Get(context.Background(), "ssh-box-example-com")
	require.NoError(t, err)
	assert.Equal(t, 8461, row.RemotePort, "the computer is registered with its port, so the hub reaches it there")
}

func TestProvisionDefaultPortIsStill8420(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "user@box.example.com"})
	plan := v["plan"].(string)
	pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	pe.waitPhase(t, plan, "done")
	row, err := pe.e.h.store.Get(context.Background(), "ssh-box-example-com")
	require.NoError(t, err)
	assert.Equal(t, 8420, row.RemotePort)
}

// What reaches the far side: the real start command, for the chosen port and for the default.
func TestProvisionStartCommandCarriesThePortAndChecksIt(t *testing.T) {
	for name, c := range map[string]struct {
		port int
		want string
		not  string
	}{"chosen": {8461, "--host 127.0.0.1 --port 8461 --no-browser", "--port 8420"}, "default": {0, "--host 127.0.0.1 --port 8420 --no-browser", "--port 8461"}} {
		t.Run(name, func(t *testing.T) {
			pe := newProvEnv(t, "known", "Linux x86_64", true)
			_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "user@box.example.com"})
			plan := v["plan"].(string)
			pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
			pe.p.version = "2.0.10"
			pl := pe.p.plan(plan)
			pl.port = c.port
			_, _, _ = pe.p.realStartRemote(context.Background(), pl) // it goes on to read the identity, which the fake far side does not have: only the commands sent matter here
			log := sshLogOf(t, pe)
			assert.Contains(t, log, c.want)
			assert.NotContains(t, log, c.not)
			assert.Regexp(t, `%04X.{1,6} `+strconv.Itoa(pl.portOrDefault())+`\)`, log, "the free-port check asks about the same port")
		})
	}
}

func TestProvisionChosenPortHeldNamesThatPort(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	require.NoError(t, os.WriteFile(filepath.Join(pe.dir, "portheld"), nil, 0o600))
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "user@box.example.com"})
	plan := v["plan"].(string)
	pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	pe.p.version = "2.0.10"
	pl := pe.p.plan(plan)
	pl.port = 8461
	_, _, err := pe.p.realStartRemote(context.Background(), pl)
	var ie *sshprov.ErrInstall
	require.ErrorAs(t, err, &ie)
	assert.Contains(t, ie.Msg, "Port 8461", "the sentence names the port that was asked for")
	assert.Contains(t, ie.Msg, "Choose another port")
	assert.NotContains(t, sshLogOf(t, pe), "--port 8461 --no-browser", "nothing was started on a held port")
}

func TestManageUpgradeStartsTheNewReleaseOnTheStoredPort(t *testing.T) {
	me := newManageEnv(t)
	_, err := me.e.db.ExecContext(context.Background(), `UPDATE remote_servers SET remote_port = 8461 WHERE id = 'ssh-box'`)
	require.NoError(t, err)
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()}, 202)
	me.waitPhase(t, plan, "failed") // the fake far Coral keeps answering with the old version: the start happened, the check failed, as in the other upgrade tests
	b, _ := os.ReadFile(filepath.Join(me.dir, "startline"))
	log := string(b)
	assert.Contains(t, log, "--port 8461 --no-browser", "the new release starts on the port the computer was set up on")
	assert.NotContains(t, log, "--port 8420", "not on the default")
	failedView := me.waitPhase(t, plan, "failed")
	assert.Contains(t, stepHelp(t, failedView, "verify"), "--port 8461 --no-browser", "and the by-hand start line carries it too")
	assert.False(t, strings.Contains(stepHelp(t, failedView, "verify"), "--port 8420"))
}
