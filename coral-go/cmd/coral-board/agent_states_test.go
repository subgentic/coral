package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19673: stop archives, interrupt ends the turn, and leave --as names the way for an Orchestrator.
func TestStopArchivesAndInterruptEndsTheTurn(t *testing.T) {
	rs := newRecordingServer(t)
	r := runBoard(t, rs.URL, t.TempDir(), "stop", "Dev 2", "--board", "team")
	require.Equal(t, 0, r.code, r.stderr)
	r = runBoard(t, rs.URL, t.TempDir(), "interrupt", "Dev 2", "--board", "team")
	require.Equal(t, 0, r.code, r.stderr)
	rs.mu.Lock()
	reqs := strings.Join(rs.reqs, "\n")
	rs.mu.Unlock()
	assert.Contains(t, reqs, "POST /api/board/team/agents/Dev 2/stop")
	assert.Contains(t, reqs, "POST /api/board/team/agents/Dev 2/interrupt")

	h := runBoard(t, rs.URL, t.TempDir(), "help", "stop")
	assert.Contains(t, h.stdout, "archived")
	assert.Contains(t, h.stdout, "coral-board interrupt")
}

func TestLeaveAsInsideAnAgentNamesStop(t *testing.T) {
	t.Setenv("CORAL_SESSION_TOKEN", "an-agents-token")
	err := runLeaveAs([]string{"--board", "b", "--as", "x"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "coral-board stop <member>")
	assert.Contains(t, err.Error(), "Operator's command")
}
