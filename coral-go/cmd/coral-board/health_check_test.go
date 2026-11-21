package main

import (
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
