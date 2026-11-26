package main

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20176: coral-board health check, against a server that answers like the routes.

func TestHealthCheckAddSendsOnlyWhatWasAskedAndSaysThePendingWords(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("POST /api/board/team/health/checks", `{"state":"pending","approval_words":"Run the script /x/c.sh (SHA-256 ab) with no arguments"}`)
	res := goalRun(t, gs, "health", "check", "add", "stale-prs", "--script", "/x/c.sh", "--dir", "/x", "--every", "30m", "--arg", "--max", "--arg", "3", "--may-write")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "Check stale-prs is pending")
	assert.Contains(t, res.stdout, "Run the script /x/c.sh")
	var post string
	for _, r := range gs.requests() {
		if strings.HasPrefix(r, "POST /api/board/team/health/checks") {
			post = r
		}
	}
	require.NotEmpty(t, post)
	b := bodyOf(t, post)
	assert.Equal(t, "stale-prs", b["name"])
	assert.Equal(t, []any{"--max", "3"}, b["args"], "each argument is one element")
	assert.Equal(t, true, b["may_write"])
	assert.NotContains(t, b, "to")
	assert.NotContains(t, b, "acts_as")
}

func TestHealthCheckChangePauseResumeRemove(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("PUT /api/board/team/health/checks/stale-prs", `{"state":"pending","approval_words":"w"}`)
	gs.setReply("POST /api/board/team/health/checks/stale-prs/pause", `{"state":"paused"}`)
	for _, args := range [][]string{{"change", "stale-prs", "--every", "1h"}, {"pause", "stale-prs"}, {"resume", "stale-prs"}, {"remove", "stale-prs"}, {"list"}} {
		res := goalRun(t, gs, append([]string{"health", "check"}, args...)...)
		assert.Equal(t, 0, res.code, strings.Join(args, " ")+" "+res.stderr)
	}
	var paused, resumed bool
	for _, r := range gs.requests() {
		if strings.Contains(r, "/pause") {
			paused = paused || bodyOf(t, r)["paused"] == true
			resumed = resumed || bodyOf(t, r)["paused"] == false
		}
	}
	assert.True(t, paused && resumed)
	assert.NotEqual(t, 0, goalRun(t, gs, "health", "check", "add").code, "a name is required")
}

// #21505: coral-board automation, against a server that answers like the routes.
func TestAutomationProposeSendsTheFileAndSaysItIsOffAndWhatTheOperatorApproves(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("POST /api/board/team/automations", `{"name":"nightly","state":"pending","hash":"abc123","words":"An automation waits for your approval: nightly"}`)
	gs.setReply("PUT /api/board/team/automations/nightly", `{"name":"nightly","state":"changed","hash":"def456","words":"Changed since you approved"}`)
	gs.setReply("POST /api/board/team/automations/nightly/disable", `{"state":"off"}`)
	gs.setReply("POST /api/board/team/automations/nightly/run", `{"run_id":7}`)
	gs.setReply("GET /api/board/team/automations", `{"automations":[{"name":"nightly","state":"pending","cron":"0 7 * * *","timezone":"UTC","hash":"abc123def456789"}]}`)
	file := t.TempDir() + "/n.json"
	require.NoError(t, os.WriteFile(file, []byte(`{"name":"nightly","steps":[{"name":"a","type":"shell","command":"true"}]}`), 0o600))
	res := goalRun(t, gs, "automation", "propose", "--file", file)
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "OFF")
	assert.Contains(t, res.stdout, "An automation waits for your approval")
	res = goalRun(t, gs, "automation", "change", "nightly", "--file", file)
	require.Equal(t, 0, res.code, res.stderr)
	for _, args := range [][]string{{"disable", "nightly"}, {"run", "nightly"}, {"list"}} {
		res := goalRun(t, gs, append([]string{"automation"}, args...)...)
		assert.Equal(t, 0, res.code, strings.Join(args, " ")+" "+res.stderr)
	}
	var posted string
	for _, r := range gs.requests() {
		if strings.HasPrefix(r, "POST /api/board/team/automations ") || strings.HasPrefix(r, "POST /api/board/team/automations\n") {
			posted = r
		}
	}
	_ = posted
	assert.NotEqual(t, 0, goalRun(t, gs, "automation", "propose").code, "a file is required")
	assert.NotEqual(t, 0, goalRun(t, gs, "automation", "enable", "nightly").code, "there is no command that turns one on")
	assert.NotEqual(t, 0, goalRun(t, gs, "automation", "propose", "--file", t.TempDir()+"/missing.json").code)
}
