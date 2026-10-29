package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

// noticeGateTerm is a terminal whose agent has not exited and that answers the notice check as set.
type noticeGateTerm struct {
	ok, wait bool
	why      string
}

func (noticeGateTerm) AgentShellIdle(context.Context, string, string, string) (bool, string, bool) {
	return false, "claude", true // the agent CLI is running: not exited
}

func (n noticeGateTerm) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	return n.ok, n.wait, n.why, true
}

// #389: the routes' gate for automated input also withholds from a terminal that is not running the agent, and lets the recorded agent through.
func TestAutomatedInputBlockedWithholdsFromATerminalThatIsNotRunningTheAgent(t *testing.T) {
	ctx := context.Background()
	const name = "claude-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4d"
	assert.True(t, automatedInputBlocked(ctx, noticeGateTerm{why: "the terminal's foreground program is not the agent"}, name, "claude", "6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4d", "board message"))
	assert.True(t, automatedInputBlocked(ctx, noticeGateTerm{wait: true, why: "starting"}, name, "claude", "6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4d", "board message"), "while the record is being made")
	assert.False(t, automatedInputBlocked(ctx, noticeGateTerm{ok: true}, name, "claude", "6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4d", "board message"), "the recorded agent is the foreground program")
}
