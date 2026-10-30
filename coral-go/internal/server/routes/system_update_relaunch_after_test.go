package routes

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// afterRows is the status's restarts, as the dashboard reads them: each agent's after and resumes.
func (e *relaunchEnv) afterRows() ([]map[string]any, map[string]any) {
	e.t.Helper()
	code, st := e.status(hubHdr(ownerA))
	require.Equal(e.t, 200, code)
	rl := st["relaunch"].(map[string]any)
	var rows []map[string]any
	for _, r := range rl["restarts"].([]any) {
		rows = append(rows, r.(map[string]any))
	}
	return rows, rl
}

func restartAgents(n int, agentType string) []RestartAgent {
	out := make([]RestartAgent, n)
	for i := range out {
		out[i] = RestartAgent{SessionID: fmt.Sprintf("s-%d", i), Name: fmt.Sprintf("a-%d", i), State: "idle", AgentType: agentType}
	}
	return out
}

// The update dialog says, per agent, what happens after the restart, by auto_wake's own rule (the operator's 2.0.3 said
// "not known whether it starts again" for all 6 of theirs): the setting, the cap, how many restart, and the CLI.
func TestTheDialogSaysWhatHappensToEachAgentAfterTheRestart(t *testing.T) {
	for _, tc := range []struct {
		name     string
		settings map[string]string
		agents   []RestartAgent
		after    string
		resumes  any // nil: not sent
	}{
		{"the operator's case: 6 agents, the default setting and cap", nil, restartAgents(6, at.Claude), afterWakes, true},
		{"at the cap they all wake", map[string]string{AutoWakeCapSetting: "3"}, restartAgents(3, at.Codex), afterWakes, true},
		{"one over the cap: the dashboard asks first", map[string]string{AutoWakeCapSetting: "3"}, restartAgents(4, at.Claude), afterAsks, nil},
		{"over the default cap of 8", nil, restartAgents(9, at.Claude), afterAsks, nil},
		{"the setting off: they stay asleep", map[string]string{AutoWakeSetting: "false"}, restartAgents(2, at.Claude), afterStaysAsleep, nil},
		{"the setting off wins over the cap", map[string]string{AutoWakeSetting: "false", AutoWakeCapSetting: "1"}, restartAgents(2, at.Claude), afterStaysAsleep, nil},
		{"a plain terminal wakes as a new shell", nil, restartAgents(1, at.Terminal), afterNewTerminal, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newRelaunchEnv(t)
			for k, v := range tc.settings {
				e.settings[k] = v
			}
			e.agents = tc.agents
			rows, _ := e.afterRows()
			require.Len(t, rows, len(tc.agents))
			for _, r := range rows {
				assert.Equal(t, tc.after, r["after"], r["session_id"])
				if tc.resumes == nil {
					// the older dashboard reads false as "starts a new conversation": not sent when that isn't so
					assert.NotContains(t, r, "resumes", r["session_id"])
				} else {
					assert.Equal(t, tc.resumes, r["resumes"], r["session_id"])
				}
			}
		})
	}
}

// Every agent type Coral runs resumes its conversation; each one's row says so.
func TestEachAgentTypeThatResumesWakesInItsOwnConversation(t *testing.T) {
	e := newRelaunchEnv(t)
	types := []string{at.Claude, at.Codex, at.Agy, at.Pi}
	e.agents = nil
	for i, ty := range types {
		e.agents = append(e.agents, RestartAgent{SessionID: fmt.Sprintf("s-%d", i), Name: ty, State: "working", AgentType: ty})
	}
	rows, _ := e.afterRows()
	require.Len(t, rows, len(types))
	for _, r := range rows {
		assert.Equal(t, afterWakes, r["after"], r["name"])
	}
}

// The cap is counted on every agent that restarts, not on the rows the status shows (maxRestartRows), and the dialog gets the
// cap to name it.
func TestTheCapCountsEveryAgentThatRestartsAndIsSent(t *testing.T) {
	e := newRelaunchEnv(t)
	e.settings[AutoWakeCapSetting] = "50"
	e.agents = restartAgents(maxRestartRows+1, at.Claude)
	rows, rl := e.afterRows()
	require.Len(t, rows, maxRestartRows)
	assert.Equal(t, afterAsks, rows[0]["after"])
	assert.EqualValues(t, 50, rl["wake_cap"])
}

// Settings that can't be read are read as their defaults, as auto_wake reads them: the status still answers.
func TestUnreadableSettingsMeanTheDefaults(t *testing.T) {
	var rows []RestartAgent = restartAgents(2, at.Claude)
	afterRestart(rows, len(rows), nil)
	for _, r := range rows {
		assert.Equal(t, afterWakes, r.After)
	}
	rows = restartAgents(9, at.Claude)
	afterRestart(rows, len(rows), nil)
	assert.Equal(t, afterAsks, rows[0].After, "the default cap is 8")
}
