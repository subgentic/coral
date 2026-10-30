package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #386: on Windows the agents mode starts none (it drives tmux), so it is refused up front with the way that works; elsewhere, and without "agents", nothing changes.
func TestAgentsModeIsRefusedOnWindowsUpFront(t *testing.T) {
	msg := agentsModeRefusal("windows", true)
	assert.Contains(t, msg, "Windows has no tmux")
	assert.Contains(t, msg, "dashboard", "it names what works")
	assert.Contains(t, msg, "without \"agents\"", "and that the web server alone still starts")
	assert.Empty(t, agentsModeRefusal("windows", false), "the web-server-only mode is unchanged")
	assert.Empty(t, agentsModeRefusal("linux", true))
	assert.Empty(t, agentsModeRefusal("darwin", true))
}
