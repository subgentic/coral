package ptymanager

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

type candTerm struct{ cand AgentCandidate }

func (c candTerm) AgentCandidate(context.Context, string, string, string, string) (AgentCandidate, string, error) {
	return c.cand, "", nil
}
func (c candTerm) RecordAgent(context.Context, string, string, string, AgentCandidate) (AgentCandidate, error) {
	return AgentCandidate{}, nil
}

func TestAgentCLIRunningIsOnlyTheAgentsOwnCLI(t *testing.T) {
	ctx := context.Background()
	run := func(c AgentCandidate, agentType string) bool {
		return AgentCLIRunning(ctx, candTerm{c}, "claude-x", agentType, "x", "claude")
	}
	assert.True(t, run(AgentCandidate{Image: "/home/u/.local/bin/claude"}, "claude"))
	assert.True(t, run(AgentCandidate{Image: `C:\Users\u\bin\Claude.exe`}, "claude"), "Windows path and .exe")
	assert.True(t, run(AgentCandidate{Image: "/usr/bin/node", Script: "/lib/node_modules/x/claude.js"}, "claude"), "a script run by node")
	assert.False(t, run(AgentCandidate{Image: "/usr/bin/less"}, "claude"))
	assert.False(t, run(AgentCandidate{Image: "/usr/bin/node", Script: "/home/u/notes.js"}, "claude"))
	assert.False(t, run(AgentCandidate{Image: "/bin/claude", Under: "bash"}, "claude"), "under a nested shell")
	assert.False(t, run(AgentCandidate{Image: "/bin/claude", Unidentified: true}, "claude"))
	assert.False(t, run(AgentCandidate{}, "claude"), "no image")
	assert.False(t, run(AgentCandidate{Image: "/bin/claude"}, "terminal"), "a terminal agent")
	assert.False(t, AgentCLIRunning(ctx, candTerm{AgentCandidate{Image: "/bin/claude"}}, "claude-x", "claude", "x", ""), "no binary to compare")
	assert.False(t, AgentCLIRunning(ctx, struct{}{}, "claude-x", "claude", "x", "claude"), "a terminal that cannot name the program")
}
