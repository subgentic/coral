package routes

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/sshprov"
)

// A computer set up over SSH whose setup could not install the Approve secret gets it from a plan of its own (#13230, the Operator: Send to agent hidden on a computer set up over SSH, no way to repair it).

func (me *manageEnv) approvals(t *testing.T) map[string]any {
	t.Helper()
	_, v := me.plan(t, "approvals", nil)
	plan, _ := v["plan"].(string)
	require.NotEmpty(t, plan, "%v", v)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	return me.waitPhase(t, plan, "done")
}

func TestApprovalsPlanInstallsTheSecretOnTheReleaseTheComputerRuns(t *testing.T) {
	me := newManageEnv(t)
	var folder string
	me.p.installOwner = func(_ context.Context, p *provisionPlan, secret string) error {
		p.mu.Lock()
		folder = p.ownerVersion
		p.mu.Unlock()
		me.ownerGiven = append(me.ownerGiven, secret)
		return nil
	}
	me.version = "2.0.9" // what the computer's Coral answers: its own release folder holds the command, not this hub's
	_ = me.approvals(t)
	require.Len(t, me.ownerGiven, 1)
	assert.Equal(t, "2.0.9", folder, "the command of the release the computer runs takes the secret")
	got, ok, err := me.e.h.store.OwnerSecret(context.Background(), "ssh-box")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, me.ownerGiven[0], got)
	row, err := me.e.h.store.Get(context.Background(), "ssh-box")
	require.NoError(t, err)
	assert.True(t, row.OwnerStamp)
}

func TestApprovalsPlanThatTheComputerRefusesSaysSoAndLogsWhy(t *testing.T) {
	logs := captureSlog(t)
	me := newManageEnv(t)
	me.p.installOwner = func(context.Context, *provisionPlan, string) error {
		return &sshprov.OwnerSecretError{ExitCode: 127, Stderr: "sh: coral: not found marker"}
	}
	_, v := me.plan(t, "approvals", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	failed := me.waitPhase(t, plan, "failed")
	assert.Contains(t, failed["error"], "did not take the secret")
	assert.NotContains(t, fmt.Sprint(failed), "not found marker", "the far computer's own text is not shown to the person")
	_, ok, _ := me.e.h.store.OwnerSecret(context.Background(), "ssh-box")
	assert.False(t, ok, "a secret the computer did not take was stored")
	l := logs()
	assert.Contains(t, l, "exit_code=127", "the hub's log has the exit code")
	assert.Contains(t, l, "not found marker", "and the start of what the computer wrote")
}

func TestApprovalsPlanLogsAnInstallThatFailedAtSetupToo(t *testing.T) {
	logs := captureSlog(t)
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	pe.ownerErr = &sshprov.OwnerSecretError{ExitCode: 3, Stderr: "refused marker"}
	_ = runToEnd(t, pe, "done")
	assert.Contains(t, logs(), "refused marker", "a setup that could not install the secret used to say nothing anywhere")
}

func TestApprovalsPlanLeavesASecretTheHubAlreadyHoldsAlone(t *testing.T) {
	me := newManageEnv(t)
	require.NoError(t, me.e.h.store.SetOwnerSecret(context.Background(), "ssh-box", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"))
	done := me.approvals(t)
	assert.Empty(t, me.ownerGiven, "a secret that is held is never replaced by this plan")
	assert.Contains(t, fmt.Sprint(done["steps"]), "already set up")
}

func TestApprovalsPlanIsNotOfferedForAComputerAddedByURL(t *testing.T) {
	me := newManageEnv(t)
	_, err := me.e.h.store.Add(context.Background(), "web", "By URL", "http://10.0.0.5:8420", routeSecret, true)
	require.NoError(t, err)
	code, _ := me.do("POST", "/api/servers/provision/plan", map[string]any{"server_id": "web", "action": "approvals"})
	assert.Equal(t, 400, code)
}

// QA Reviewer 2's pins on #13251. The release folder that takes the secret is the one the computer runs, and this hub's own only when that is unknown or not a plain version.
func TestOwnerFolderIsTheReleaseTheComputerRunsElseThisHubs(t *testing.T) {
	pr := &Provisioner{version: "2.0.10"}
	for in, want := range map[string]string{"2.0.9": "2.0.9", "2.0.9-rc.1": "2.0.9-rc.1", "": "2.0.10", "../x": "2.0.10", "2.0.9; rm -rf ~": "2.0.10", "v2": "2.0.10"} {
		p := &provisionPlan{ownerVersion: in}
		assert.Equal(t, want, pr.ownerFolder(p), "the far computer answered %q", in)
	}
}

// A computer that is not the one that was set up gets nothing: no secret is made, none is installed, none is saved, and the person sees why.
func TestApprovalsPlanOnAnotherComputerInstallsNothing(t *testing.T) {
	me := newManageEnv(t)
	require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "instance-id"), []byte("00000000-0000-4000-8000-000000000000\n"), 0o600))
	_, v := me.plan(t, "approvals", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{}, 202)
	failed := me.waitPhase(t, plan, "failed")
	assert.Contains(t, failed["error"], "not the computer that was set up", "the person sees the refusal")
	assert.Empty(t, me.ownerGiven, "nothing was installed on another computer")
	_, ok, _ := me.e.h.store.OwnerSecret(context.Background(), "ssh-box")
	assert.False(t, ok, "and nothing was saved")
}

// The real installOwner (not a test's stand-in) runs the command of the release folder ownerFolder names (#13272, QA Reviewer 2): the far computer's release when an approvals plan read it, this hub's otherwise.
func TestTheRealInstallOwnerRunsTheFolderOwnerFolderNames(t *testing.T) {
	me := newManageEnv(t)
	dir := t.TempDir()
	seen := filepath.Join(dir, "seen")
	ssh := filepath.Join(dir, "ssh")
	require.NoError(t, os.WriteFile(ssh, []byte("#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\ncat >/dev/null\nprintf %s \"$last\" > '"+seen+"'\nexit 0\n"), 0o700))
	pr := NewProvisioner(me.e.h.store)
	pr.runner = sshprov.Runner{SSH: ssh}
	pr.version = "2.0.10"
	tg, err := sshTargetOf("user@box.example.com:22")
	require.NoError(t, err)
	for ownerVersion, want := range map[string]string{"2.0.9": "/2.0.9/root/coral", "": "/2.0.10/root/coral"} {
		p := &provisionPlan{Target: tg, ServerID: "ssh-box", ownerVersion: ownerVersion}
		require.NoError(t, pr.installOwner(context.Background(), p, strings.Repeat("ab", 32)))
		got, err := os.ReadFile(seen)
		require.NoError(t, err)
		assert.Contains(t, string(got), want, "the far computer answered %q", ownerVersion)
		assert.Contains(t, string(got), "hub-owner-secret")
	}
}
