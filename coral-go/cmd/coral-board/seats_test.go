package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11112: the Operator's clean-up of leftover board seats, from the command line outside an agent: `coral-board seats --foreign` lists the seats of agents launched on another board, and
// `coral-board leave --board <board> --as <name>` removes one. An agent's own shell (its session token in the environment) is refused before anything is sent.

func seatsServer(t *testing.T, hits *[]string, status int, body string) {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits = append(*hits, r.Method+" "+r.URL.EscapedPath())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(ts.Close)
	old := serverURL
	serverURL = ts.URL
	t.Cleanup(func() { serverURL = old })
}

const foreignSeatsReply = `{"seats":[{"board_id":"b-team-b","board_label":"team-b","subscriber_id":"Backend Dev","job_title":"Dev","session_name":"claude-s1","session_id":"s1","agent_name":"wanderer","launch_board":"b-team-a","launch_board_label":"team-a","subscribed_at":"2026-10-01T00:00:00Z"}]}`

func TestSeatsForeignListsTheSeatsOfAgentsLaunchedElsewhere(t *testing.T) {
	t.Setenv("CORAL_SESSION_TOKEN", "")
	var hits []string
	seatsServer(t, &hits, http.StatusOK, foreignSeatsReply)
	var out bytes.Buffer
	require.NoError(t, runSeats([]string{"--foreign"}, &out))
	assert.Equal(t, []string{"GET /api/board-seats/foreign"}, hits)
	text := out.String()
	assert.Contains(t, text, "team-b")
	assert.Contains(t, text, "Backend Dev")
	assert.Contains(t, text, "team-a", "it says where the agent was launched")
	assert.Contains(t, text, "coral-board leave --board b-team-b --as \"Backend Dev\"", "and the command that removes the seat")

	out.Reset()
	require.NoError(t, runSeats([]string{"--foreign", "--json"}, &out))
	assert.JSONEq(t, foreignSeatsReply, out.String())

	var none []string
	seatsServer(t, &none, http.StatusOK, `{"seats":[]}`)
	out.Reset()
	require.NoError(t, runSeats([]string{"--foreign"}, &out))
	assert.Contains(t, out.String(), "No foreign seats")
}

func TestSeatsNeedsForeignAndIsNotForAnAgent(t *testing.T) {
	var hits []string
	seatsServer(t, &hits, http.StatusOK, foreignSeatsReply)
	t.Setenv("CORAL_SESSION_TOKEN", "")
	err := runSeats(nil, &bytes.Buffer{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "--foreign")
	assert.Error(t, runSeats([]string{"--foreign", "extra"}, &bytes.Buffer{}))

	t.Setenv("CORAL_SESSION_TOKEN", "an-agents-token")
	err = runSeats([]string{"--foreign"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "outside an agent")
	assert.Empty(t, hits, "nothing was sent from an agent's shell")
}

func TestLeaveAsRemovesOneSeatAsTheOperator(t *testing.T) {
	t.Setenv("CORAL_SESSION_TOKEN", "")
	var hits []string
	seatsServer(t, &hits, http.StatusOK, `{"ok":true}`)
	var out bytes.Buffer
	require.NoError(t, runLeaveAs([]string{"--board", "b-team-b", "--as", "Backend Dev"}, &out))
	assert.Equal(t, []string{"DELETE /api/board/b-team-b/seats/Backend%20Dev"}, hits, "the name is escaped into the path")
	assert.Contains(t, out.String(), "Backend Dev")
	assert.Contains(t, out.String(), "b-team-b")

	for name, args := range map[string][]string{
		"no board":                  {"--as", "x"},
		"no name":                   {"--board", "b"},
		"a name that is only space": {"--board", "b", "--as", "  "},
		"extra":                     {"--board", "b", "--as", "x", "y"},
	} {
		hits = nil
		assert.Error(t, runLeaveAs(args, &bytes.Buffer{}), name)
		assert.Empty(t, hits, name)
	}

	var gone []string
	seatsServer(t, &gone, http.StatusNotFound, `{"error":"that board has no such seat"}`)
	err := runLeaveAs([]string{"--board", "b", "--as", "x"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no such seat")

	t.Setenv("CORAL_SESSION_TOKEN", "an-agents-token")
	var none []string
	seatsServer(t, &none, http.StatusOK, `{"ok":true}`)
	err = runLeaveAs([]string{"--board", "b", "--as", "x"}, &bytes.Buffer{})
	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "outside an agent"))
	assert.Empty(t, none, "an agent's shell sends nothing")
}
