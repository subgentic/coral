package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11417: coral-board ask close <id> --note "...": the request it sends, what it prints, and what it refuses.
func TestAskCloseSendsTheNoteAndPrintsTheId(t *testing.T) {
	gs := newGoalServer(t)
	res := goalRun(t, gs, "ask", "close", "138734", "--note", "answered in the chat")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Equal(t, "Closed the question in message #138734.\n", res.stdout)
	reqs := gs.requests()
	require.Len(t, reqs, 1)
	assert.Contains(t, reqs[0], "POST /api/board/team/asks/138734/close? ")
	assert.Equal(t, map[string]any{"subscriber_id": "Tester", "note": "answered in the chat"}, bodyOf(t, reqs[0]))

	res = goalRun(t, gs, "ask", "close", "#138735", "--note=in an artifact comment")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, gs.requests()[1], "/asks/138735/close")
}

func TestAskCloseNeedsANoteAndAnId(t *testing.T) {
	gs := newGoalServer(t)
	for name, args := range map[string][]string{
		"no id":        {"ask", "close"},
		"not a number": {"ask", "close", "abc", "--note", "x"},
		"no note":      {"ask", "close", "5"},
		"a blank note": {"ask", "close", "5", "--note", "  "},
		"unknown":      {"ask", "open", "5"},
	} {
		res := goalRun(t, gs, args...)
		assert.Equal(t, 1, res.code, name)
		assert.Contains(t, res.stderr, "ask close", name)
	}
	assert.Empty(t, gs.requests(), "nothing is sent without an id and a note")
	gs.setStatus(403)
	res := goalRun(t, gs, "ask", "close", "5", "--note", "x")
	assert.Equal(t, 5, res.code, "a refusal ends the command with the refusal exit code")
	assert.Contains(t, res.stderr, "closing the question")
}
