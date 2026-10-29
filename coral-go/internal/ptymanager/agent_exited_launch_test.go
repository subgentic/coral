package ptymanager

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

// fakeExitTerm says the agent's shell is idle (its CLI exited) or not, and which shell of unknown contents runs in it.
type fakeExitTerm struct {
	idle  bool
	other string
}

func (f fakeExitTerm) AgentShellIdle(context.Context, string, string, string) (bool, string, bool) {
	return f.idle, "powershell", true
}

func (f fakeExitTerm) AgentUnknownShell(context.Context, string, string, string) (string, bool) {
	return f.other, true
}

// #216 (Security's guard): for the launch-line paths a terminal whose shell is of unknown contents is not "exited" (a launch line
// would be typed into whatever runs in it), and the refusal says why; notices (AgentExited) still treat it as exited, so they are
// withheld from it too.
func TestAgentExitedForLaunchRefusesAShellOfUnknownContents(t *testing.T) {
	ctx := context.Background()
	exited, fg, refusal := AgentExitedForLaunch(ctx, fakeExitTerm{idle: true, other: "bash"}, "claude-x", "claude", "")
	assert.False(t, exited)
	assert.Equal(t, "bash", fg)
	assert.Equal(t, UnknownShellRefusal("bash"), refusal)
	notice, _ := AgentExited(ctx, fakeExitTerm{idle: true, other: "bash"}, "claude-x", "claude", "")
	assert.True(t, notice, "notices still withheld")

	exited, _, refusal = AgentExitedForLaunch(ctx, fakeExitTerm{idle: true}, "claude-x", "claude", "")
	assert.True(t, exited, "a bare PowerShell: the launch line goes, as before")
	assert.Empty(t, refusal)

	exited, _, refusal = AgentExitedForLaunch(ctx, fakeExitTerm{idle: false, other: "bash"}, "claude-x", "claude", "")
	assert.False(t, exited, "a running agent is not exited either way")
	assert.Empty(t, refusal)
	assert.Contains(t, UnknownShellRefusal("bash"), "this terminal is running bash")
}
